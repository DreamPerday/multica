#!/usr/bin/env node
/**
 * Multica ⇄ DeepSeek Harness bridge.
 *
 * Multica's `dsh` provider drives a versioned JSONL stdio protocol on the
 * process it launches (`<exe> --profile multica --stdio`). DSH itself does not
 * speak that protocol — upstream expects an `@multica-ai/dsh-runtime` profile
 * bundle that is not published yet (multica#6936). This bridge closes that gap
 * from the outside instead of installing anything into DSH's profile store:
 *
 *   Multica daemon ──spawn──▶ this bridge ──spawn──▶ dsh --profile headless --json
 *                              (Multica JSONL)              (DSH run events)
 *
 * Register it as a custom runtime profile with protocol family `dsh` and
 * command name `dsh-multica-bridge`; Multica then launches
 * `dsh-multica-bridge --profile multica --stdio`, and the argv is ignored.
 *
 * Wire formats
 * ------------
 * Inbound (Multica → bridge), one JSON object per line:
 *   {v:1, type:"execute", request_id, cwd, prompt, resume_session_id?,
 *    model?:{provider,id}, reasoning_effort?, mcp_servers?}
 *   {v:1, type:"cancel", request_id}
 *
 * Outbound (bridge → Multica), one JSON object per line, `v` always 1:
 *   {type:"ready", runtime:"dsh"}      — required; Multica stays "not ready" until it sees runtime=="dsh"
 *   {type:"session", session_id}
 *   {type:"text"|"thinking", content}
 *   {type:"tool_call", call_id, name, arguments}
 *   {type:"tool_result", call_id, name, output}
 *   {type:"usage", provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}
 *   {type:"protocol_error", code, message}
 *   {type:"result", status, output, session_id, error?:{code,message}, resume_rejected}
 *   {type:"models", models:[...]}      — only for --list-models
 *
 * Everything this file prints to stdout must be a protocol frame. Diagnostics
 * go to stderr, which Multica keeps as a bounded tail for error reporting.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const PROTOCOL_VERSION = 1;

/**
 * Model catalog advertised to Multica.
 *
 * Multica's DSH provider asks the runtime for `--list-models` and expects a
 * `models` frame whose entries carry the `provider` DSH would use. The models
 * DSH can actually run are whatever routes the headless profile configures, so
 * this is read from that profile's own patch layer instead of being hardcoded —
 * otherwise the picker either shows nothing useful or offers models the profile
 * cannot run.
 *
 * `dsh headless` has no per-run model flag (`--help` exposes only --json and
 * --session-id), so a selection is applied by handing DSH an extra `--patch`
 * overlay that repoints `agent-default-model` before the run starts.
 */
const PROFILE_PATCH = join(
  process.env.DSH_HOME ?? join(homedir(), ".dsh"),
  "profiles",
  "headless",
  "cordis.patch.yml",
);

function readModelCatalog() {
  const fallback = {
    provider: process.env.DSH_BRIDGE_MODEL_PROVIDER ?? "cc-switch-open-code-go",
    id: process.env.DSH_BRIDGE_MODEL_ID ?? "deepseek-v4.1-flash",
    label: process.env.DSH_BRIDGE_MODEL_LABEL ?? "DeepSeek V4.1 Flash",
  };

  let text;
  try {
    text = readFileSync(PROFILE_PATCH, "utf8");
  } catch {
    return [fallback];
  }

  // Indentation-driven scan of:
  //
  //   - id: llm-pi-ai
  //     config:
  //       providers:
  //         <provider>:
  //           models:
  //           - name: <label>
  //             ...
  //             id: <model-id>
  //
  // The bridge has no YAML parser and the shape is fixed, so this walks the
  // lines by indent rather than pulling in a dependency.
  const models = [];
  const lines = text.split(/\r?\n/);
  let inLlm = false;
  let llmIndent = -1;
  let inProviders = false;
  let providersIndent = -1;
  let provider = null;
  let inModels = false;
  let modelsIndent = -1;
  let pending = null;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (body.startsWith("- id:")) {
      inLlm = body.slice(5).trim() === "llm-pi-ai";
      llmIndent = indent;
      inProviders = false;
      provider = null;
      inModels = false;
      pending = null;
      continue;
    }
    if (!inLlm) continue;
    if (indent <= llmIndent && !body.startsWith("config:")) {
      inLlm = false;
      continue;
    }

    if (body === "providers:") {
      inProviders = true;
      providersIndent = indent;
      continue;
    }
    if (!inProviders) continue;
    if (indent <= providersIndent) {
      inProviders = false;
      continue;
    }

    if (body === "models:") {
      inModels = true;
      modelsIndent = indent;
      continue;
    }
    if (!inModels) {
      // `<provider>:` sits directly under `providers:`.
      if (indent === providersIndent + 2 && body.endsWith(":")) {
        provider = body.slice(0, -1).trim();
      }
      continue;
    }

    if (indent <= modelsIndent && !body.startsWith("- ")) {
      inModels = false;
      continue;
    }

    const nameMatch = /^-\s*name:\s*(.+)$/.exec(body);
    if (nameMatch) {
      pending = { label: nameMatch[1].trim(), id: null };
      continue;
    }
    const idMatch = /^id:\s*(.+)$/.exec(body);
    if (idMatch && pending) {
      pending.id = idMatch[1].trim();
      if (provider && pending.id) {
        models.push({ provider, id: pending.id, label: pending.label || pending.id });
      }
      pending = null;
    }
  }

  return models.length > 0 ? models : [fallback];
}

const MODEL_CATALOG = readModelCatalog();

/**
 * Write a throwaway `--patch` overlay pinning `agent-default-model` to the
 * selection Multica sent. Returns null when the run should just use the
 * profile's configured default.
 */
function writeModelOverridePatch(selection) {
  if (!selection?.provider || !selection?.id) return null;
  const dir = mkdtempSync(join(tmpdir(), "dsh-bridge-model-"));
  const file = join(dir, "model-override.yml");
  writeFileSync(
    file,
    [
      "- id: agent-default-model",
      "  config:",
      `    provider: ${JSON.stringify(selection.provider)}`,
      `    model: ${JSON.stringify(selection.id)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { file, dir };
}


const diag = (message) => process.stderr.write(`[dsh-bridge] ${message}\n`);

/**
 * Restore `MULTICA_TOKEN` for the platform CLI the agent is told to call.
 *
 * DSH hands shell tools a curated environment: inside a real task
 * `MULTICA_CLI_PATH` and `MULTICA_DAEMON_PORT` survive but `MULTICA_TOKEN` does
 * not, so every `& "$env:MULTICA_CLI_PATH" issue get ...` fails with "agent
 * execution context requires MULTICA_TOKEN to be a task-scoped mat_ token". The
 * agent retries, the turn never ends, and Multica shows the run as still
 * generating long after the answer was written.
 *
 * `MULTICA_CLI_PATH` does survive, so it is repointed at a one-run wrapper that
 * sets the token and execs the real CLI. The wrapper carries a task-scoped token
 * in a private temp directory that is removed when the run ends; the token is
 * never logged.
 */
function writeCliAuthWrapper() {
  const token = process.env.MULTICA_TOKEN;
  const realCli = process.env.MULTICA_CLI_PATH;
  if (!token || !realCli) return null;

  const dir = mkdtempSync(join(tmpdir(), "dsh-bridge-cli-"));
  const file = join(dir, "multica-auth.cmd");
  // The real path travels through the environment rather than the file body: a
  // CLI installed under a non-ASCII path would be mis-parsed by cmd.exe.
  writeFileSync(
    file,
    [
      "@echo off",
      "setlocal",
      `set "MULTICA_TOKEN=${token}"`,
      `"%MULTICA_BRIDGE_REAL_CLI%" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
    "utf8",
  );
  return { file, dir };
}

// Multica writes an AGENTS.md brief into the task workdir telling the agent to
// run platform commands as `& "$env:MULTICA_CLI_PATH" ...`. The daemon exports
// that variable for task processes; when this bridge is launched as a *custom
// runtime profile* command the variable can arrive unset, and then every such
// call expands to an empty program name, fails, and the agent retries in a
// loop — which is what left runs "typing" long after they should have ended.
// Fall back to the CLI installed beside this bridge.
if (!process.env.MULTICA_CLI_PATH) {
  const besideBridge = join(dirname(fileURLToPath(import.meta.url)), "multica.exe");
  if (existsSync(besideBridge)) {
    process.env.MULTICA_CLI_PATH = besideBridge;
    diag(`MULTICA_CLI_PATH was unset; defaulted to ${besideBridge}`);
  } else {
    diag("MULTICA_CLI_PATH is unset and no multica.exe sits beside the bridge");
  }
} else {
  diag(`MULTICA_CLI_PATH provided by the daemon: ${process.env.MULTICA_CLI_PATH}`);
}

// Task-scoped auth for the CLI the runtime brief tells the agent to call. The
// CLI rejects anything that is not a `mat_` task token ("agent execution
// context requires MULTICA_TOKEN to be a task-scoped mat_ token"), so log only
// its shape — never the value.
diag(
  process.env.MULTICA_TOKEN
    ? `MULTICA_TOKEN present: prefix=${String(process.env.MULTICA_TOKEN).slice(0, 4)} length=${process.env.MULTICA_TOKEN.length}`
    : "MULTICA_TOKEN is missing from the environment",
);

function writeFrame(frame) {
  const line = JSON.stringify({ v: PROTOCOL_VERSION, ...frame });
  process.stdout.write(`${line}\n`);
}

/**
 * Resolve how to start DSH.
 *
 * DSH Desktop installs a `.cmd` shim under a per-generation directory and only
 * puts it on PATH for processes it spawns itself; a daemon started by Multica
 * inherits no such path, so the newest generation is the fallback.
 *
 * The shim is never executed directly on Windows. Neither `shell: true` (it
 * concatenates an unescaped command line and splits this project's path on its
 * space) nor a bare spawn (libuv reports EINVAL for a batch file) works, and
 * routing through cmd.exe mangles a non-ASCII install path. The shim's body is
 * just `set` lines plus one `"<exe>" --expose-internals "<js>"` call, so it is
 * parsed instead and the executable is spawned with a normal argv.
 *
 * Returns { exe, prefixArgs, env } or null when nothing usable is found.
 */
function resolveDshLaunch() {
  const explicit = process.env.DSH_BRIDGE_DSH_BINARY;
  const candidates = [];

  if (explicit) candidates.push(explicit);

  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh.bat"] : ["dsh"];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of names) candidates.push(join(dir, name));
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const generations = join(appData, "DSH Desktop", "host-commands", "desktop", "generations");
    if (existsSync(generations)) {
      const dirs = readdirSync(generations, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const dir of dirs) {
        for (const name of names) candidates.push(join(generations, dir, "bin", name));
      }
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const isBatch = /\.(cmd|bat)$/i.test(candidate);
    if (!isBatch) return { exe: candidate, prefixArgs: [], env: {} };
    const parsed = parseBatchShim(candidate);
    if (parsed) return parsed;
    diag(`could not parse ${candidate}; falling back to a direct spawn`);
    return { exe: candidate, prefixArgs: [], env: {} };
  }

  return null;
}

/** Expand the variable forms a launcher shim uses: %NAME% and %~dp0. */
function expandBatchVars(value, shimDir) {
  return value
    .replace(/%~dp0/gi, shimDir.endsWith("\\") ? shimDir : `${shimDir}\\`)
    .replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
}

/** Extract the executable, its fixed arguments, and the env a shim exports. */
function parseBatchShim(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const shimDir = dirname(path);
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const assignment = /^\s*set\s+"([^"=]+)=(.*)"\s*$/.exec(line);
    if (assignment) env[assignment[1]] = expandBatchVars(assignment[2], shimDir);
  }

  // The invocation line begins with a quoted path and passes `%*` through.
  const invocation = /^\s*"([^"]+)"\s*(.*)$/m.exec(text);
  if (!invocation) return null;
  const exe = expandBatchVars(invocation[1], shimDir);
  if (!existsSync(exe)) return null;

  const prefixArgs = [];
  const argPattern = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = argPattern.exec(invocation[2])) !== null) {
    const value = match[1] ?? match[2];
    if (value === "%*" || value === "|") break;
    prefixArgs.push(expandBatchVars(value, shimDir));
  }

  return { exe, prefixArgs, env };
}

/** Locate the model-route overlay shipped beside this bridge. */
function resolvePatchFile() {
  if (process.env.DSH_BRIDGE_MODEL_PATCH) {
    return existsSync(process.env.DSH_BRIDGE_MODEL_PATCH) ? process.env.DSH_BRIDGE_MODEL_PATCH : null;
  }
  const beside = join(dirname(fileURLToPath(import.meta.url)), "model-route.yml");
  return existsSync(beside) ? beside : null;
}

/** Run one `dsh headless --json` turn and translate its events.
 *
 *  DSH emits (`@deepseek-ai/dsh-headless` json-stream projection):
 *    {type:"session", sessionId, cwd}
 *    {type:"status", phase:"turn_start"|"step_start"|"step_end"|"turn_end", turn, step?, reason?, usage?}
 *    {type:"thinking", text} / {type:"text", text}
 *    {type:"tool_call", callId, tool, input}
 *    {type:"tool_result", callId, status, result}
 *    {type:"final", text}
 */
function runTurn(command, { onDone }) {
  const requestId = command.request_id ?? "";
  const launch = resolveDshLaunch();
  if (!launch) {
    writeFrame({
      type: "result",
      request_id: requestId,
      status: "failed",
      error: {
        code: "DSH_NOT_FOUND",
        message: "dsh executable not found on PATH or under the DSH Desktop install directory",
      },
    });
    onDone();
    return null;
  }

  // The task travels on stdin (`-`), not in argv: a prompt is arbitrary user
  // text, and quoting it through a Windows command line is where this breaks.
  // `--patch` is a *launcher* flag and must precede `--profile`; given after it,
  // the headless app rejects it with "unknown option '--patch'" because the rest
  // of the argv is forwarded to the app untouched.
  const profileArgs = [];
  // A model chosen in Multica overrides the profile default for this run only:
  // headless has no --model flag, so the selection travels as a patch overlay.
  const modelOverride = writeModelOverridePatch(command.model);
  const patchFile = modelOverride?.file ?? resolvePatchFile();
  if (patchFile) profileArgs.push("--patch", patchFile);
  profileArgs.push("--profile", "headless", "--json");
  if (command.resume_session_id) profileArgs.push("--session-id", command.resume_session_id);
  profileArgs.push("-");
  const args = [...launch.prefixArgs, ...profileArgs];

  const cliWrapper = writeCliAuthWrapper();
  if (cliWrapper) diag(`CLI auth wrapper: ${cliWrapper.file}`);

  diag(
    `spawn ${launch.exe} ${args.join(" ")} (cwd=${command.cwd ?? process.cwd()})`,
  );

  // Spawn the resolved executable with a plain argv. See resolveDshLaunch for
  // why the .cmd shim itself is parsed instead of executed.
  const child = spawn(launch.exe, args, {
    cwd: command.cwd || process.cwd(),
    // The shim exports ELECTRON_RUN_AS_NODE / DSH_HOME / DSH_DESKTOP_DEFAULT_PROFILE.
    // Spawning the executable directly means replaying them here.
    //
    // DSH_PERMISSION_MODE: dsh-base defaults this to `workspace-write`
    // (`sandbox-policy.mode`). On this machine that mode runs commands through a
    // sandbox runner that reports exit 0 while discarding the command's stdout —
    // `Write-Output abcdef` came back as "\r\n". An agent then sees an empty
    // result for every command and concludes its shell is broken, so
    // Multica-driven runs cannot do real work. `danger-full-access` captures
    // stdout correctly (verified end to end). Override with
    // DSH_BRIDGE_PERMISSION_MODE if that trade-off is not wanted.
    env: {
      ...process.env,
      DSH_PERMISSION_MODE: process.env.DSH_BRIDGE_PERMISSION_MODE ?? "danger-full-access",
      ...launch.env,
      // Repoint the CLI the brief tells the agent to call at a wrapper that
      // restores MULTICA_TOKEN, which DSH drops from tool environments.
      ...(cliWrapper
        ? {
            MULTICA_CLI_PATH: cliWrapper.file,
            MULTICA_BRIDGE_REAL_CLI: process.env.MULTICA_CLI_PATH,
          }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdin.on("error", (error) => diag(`stdin write failed: ${String(error?.message ?? error)}`));
  child.stdin.end(command.prompt ?? "");

  // Multica's tool_result frame carries a tool name; DSH's does not, so the
  // call_id → name mapping is remembered from the matching tool_call.
  const toolNames = new Map();
  let sessionId = command.resume_session_id ?? "";
  let finalText = "";
  let sawFinal = false;
  let settled = false;
  let lastEventAt = Date.now();
  // When the newest output is an assistant message (see case "text"). Any later
  // tool/status activity clears it, so a long-running step is never mistaken
  // for a finished turn.
  let lastTextAt = 0;
  let lastAssistantText = "";
  let turnEndTimer = null;
  let failure = null;
  let stderrTail = "";
  let cancelled = false;

  const emitUsage = (usage) => {
    if (!usage) return;
    writeFrame({
      type: "usage",
      request_id: requestId,
      provider: usage.provider ?? MODEL_CATALOG[0].provider,
      model: usage.model ?? command.model?.id ?? MODEL_CATALOG[0].id,
      input_tokens: usage.inputTokens ?? usage.input_tokens ?? 0,
      output_tokens: usage.outputTokens ?? usage.output_tokens ?? 0,
      cache_read_tokens: usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0,
      cache_write_tokens: usage.cacheWriteTokens ?? usage.cache_write_tokens ?? 0,
    });
  };

  const handleEvent = (event) => {
    switch (event?.type) {
      case "session":
        sessionId = event.sessionId ?? sessionId;
        writeFrame({ type: "session", request_id: requestId, session_id: sessionId });
        return;
      case "text":
        if (event.text) {
          writeFrame({ type: "text", request_id: requestId, content: event.text });
          // An assistant message is the last thing a finished turn emits. DSH
          // then goes quiet without `final` and without exiting, which is what
          // leaves Multica's chat box showing "typing". Remember when that
          // message landed so the watchdog can close the run after a short
          // quiet period instead of waiting for an event that never comes.
          lastTextAt = Date.now();
          lastAssistantText = event.text;
        }
        return;
      case "thinking":
        if (event.text) writeFrame({ type: "thinking", request_id: requestId, content: event.text });
        return;
      case "tool_call": {
        const name = event.tool ?? event.name ?? "";
        if (event.callId) toolNames.set(event.callId, name);
        writeFrame({
          type: "tool_call",
          request_id: requestId,
          call_id: event.callId ?? "",
          name,
          arguments: JSON.stringify(event.input ?? {}),
        });
        return;
      }
      case "tool_result":
        writeFrame({
          type: "tool_result",
          request_id: requestId,
          call_id: event.callId ?? "",
          name: toolNames.get(event.callId) ?? "",
          output: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
          is_error: event.status === "error",
        });
        return;
      case "status":
        if (event.phase === "step_end") emitUsage(event.usage);
        if (event.phase === "turn_end") {
          if (event.reason?.kind === "error") {
            const error = event.reason.error ?? {};
            failure = { code: error.code ?? "TURN_FAILED", message: error.message ?? "turn ended with an error" };
            return;
          }
          // `turn_end` is DSH's own statement that the turn is over. Acting only
          // on `final` meant a run whose `final` never arrives (the process
          // lingers after tool use) stayed "generating" in Multica forever, even
          // though the agent had already answered.
          //
          // `final` normally follows `turn_end` a moment later and carries the
          // authoritative answer text, so this waits one beat for it and only
          // then completes, falling back to the last assistant message.
          diag("turn_end (completed) received; completing shortly");
          if (turnEndTimer) clearTimeout(turnEndTimer);
          turnEndTimer = setTimeout(() => {
            turnEndTimer = null;
            if (settled) return;
            if (!finalText) finalText = lastAssistantText;
            finish("completed");
            stopChild();
          }, 1_500);
        }
        return;
      case "final":
        finalText = event.text ?? "";
        sawFinal = true;
        // DSH does not exit when the turn ends: the desktop CLI keeps its
        // process (and the MCP children it started) alive. Waiting for the exit
        // to send `result` therefore left Multica showing the run as still
        // generating long after the answer had arrived. Report completion off
        // the `final` event instead, and stop the child once the frame is out.
        setImmediate(() => {
          if (settled) return;
          finish(failure ? "failed" : "completed", failure ? { error: failure } : {});
          stopChild();
        });
        return;
      default:
        diag(`ignoring unknown dsh event type ${JSON.stringify(event?.type)}`);
    }
  };

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    lastEventAt = Date.now();
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      diag(`non-JSON line from dsh: ${trimmed.slice(0, 200)}`);
      return;
    }
    // Diagnostic trace of the raw DSH vocabulary; off unless asked for.
    if (process.env.DSH_BRIDGE_TRACE) {
      const phase = event?.phase ? `/${event.phase}` : "";
      const reason = event?.reason?.kind ? `/${event.reason.kind}` : "";
      diag(`event ${event?.type}${phase}${reason}`);
    }
    // Anything other than an assistant message supersedes it: the turn is still
    // working, so the quiet-after-message shortcut must not fire.
    if (event?.type !== "text") lastTextAt = 0;
    handleEvent(event);
  });

  // Stall watchdog. DSH sometimes finishes the work — the agent has answered,
  // posted its comment, even moved the issue to in_review — yet never emits
  // `final` and never exits, so the run stays "generating" until a human
  // cancels it. Nothing else can distinguish that from a genuine long step, so
  // a generous quiet period ends the run explicitly instead of hanging.
  const stallMs = Number(process.env.DSH_BRIDGE_STALL_MS ?? 300_000);
  // Guard-rail only, and therefore OFF by default: an assistant message is NOT
  // proof that the turn ended — agents here routinely post a line like
  // "I'll start by reading the issue" and then keep calling tools. Treating
  // quiet-after-message as completion would kill real work whenever the model
  // or the network pauses. Set DSH_BRIDGE_QUIET_MS only if you accept that
  // risk (e.g. 20000 on a fast local model).
  const quietMs = Number(process.env.DSH_BRIDGE_QUIET_MS ?? 0);
  const stallTimer = setInterval(() => {
    if (settled) return;
    const idleMs = Date.now() - lastEventAt;
    const sinceTextMs = lastTextAt === 0 ? -1 : Date.now() - lastTextAt;
    // Per-tick logging is diagnostic only; it would otherwise write a line
    // every 15s into the daemon's bounded stderr tail for every run.
    if (process.env.DSH_BRIDGE_WATCHDOG_LOG) {
      diag(`watchdog tick: idle ${idleMs}ms of ${stallMs}ms, sinceText ${sinceTextMs}ms`);
    }    if (quietMs > 0 && lastTextAt !== 0 && sinceTextMs >= quietMs) {
      diag(`assistant message quiet for ${sinceTextMs}ms; completing the run`);
      finish("completed");
      stopChild();
      return;
    }
    if (idleMs < stallMs) return;
    diag(`no dsh output for ${stallMs}ms; finishing the run`);
    finish("failed", {
      error: {
        code: "DSH_STALLED",
        message: `dsh produced no output for ${stallMs}ms after the last event`,
      },
    });
    stopChild();
  }, 15_000);

  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderrTail = (stderrTail + text).slice(-4096);
    process.stderr.write(text);
  });

  const finish = (status, extra = {}) => {
    if (settled) return;
    settled = true;
    clearInterval(stallTimer);
    writeFrame({
      type: "result",
      request_id: requestId,
      status,
      output: finalText,
      session_id: sessionId,
      ...extra,
    });
    onDone();
    // The daemon finalises a run when the provider process exits — its log line
    // is "dsh finished ... status=succeeded". Staying alive as a reusable
    // endpoint left runs "running" forever even though the frame was delivered.
    //
    // Exit by draining handles rather than process.exit(): on Windows a pipe
    // write is asynchronous, and a hard exit truncates the result frame, which
    // the daemon then reports as a failed run.
    try {
      reader.close();
    } catch {
      /* already closed */
    }
    try {
      process.stdin.destroy();
    } catch {
      /* stdin may be gone */
    }
  };

  // Terminate the child and anything it started. Used when the run is finished
  // (dsh lingers after its turn) and when Multica cancels.
  const stopChild = () => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch (error) {
      diag(`stop child failed: ${String(error?.message ?? error)}`);
    }
  };

  child.on("error", (error) => {
    finish("failed", { error: { code: "SPAWN_FAILED", message: String(error?.message ?? error) } });
  });

  child.on("close", (code) => {
    reader.close();
    if (modelOverride) {
      try {
        rmSync(modelOverride.dir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best effort */
      }
    }
    if (cliWrapper) {
      try {
        rmSync(cliWrapper.dir, { recursive: true, force: true });
      } catch {
        /* the wrapper only carries a task-scoped token; drop it best effort */
      }
    }
    if (cancelled) {
      finish("cancelled", { error: { code: "CANCELLED", message: "run cancelled" } });
      return;
    }
    if (failure) {
      finish("failed", { error: failure });
      return;
    }
    if (code !== 0 && !sawFinal) {
      finish("failed", {
        error: {
          code: "DSH_EXIT",
          message: `dsh exited with code ${code}${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ""}`,
        },
      });
      return;
    }
    finish("completed");
  });

  return {
    cancel() {
      cancelled = true;
      diag("cancel requested");
      stopChild();
    },
  };
}

function main() {
  const argv = process.argv.slice(2);

  // Multica probes the model catalog with this flag before registering.
  if (argv.includes("--list-models")) {
    writeFrame({
      type: "models",
      models: MODEL_CATALOG.map((model, index) => ({
        // Multica's picker stores `m.id` verbatim as the agent's model, and the
        // DSH launcher requires the advertised ID to be the `provider/model`
        // pair it can split back apart (`dsh model must use the provider/model
        // ID advertised by DSH`). A bare model id here therefore fails at run
        // time, so the composite form is what gets advertised.
        id: `${model.provider}/${model.id}`,
        label: model.label,
        provider: model.provider,
        default: index === 0,
      })),
    });
    return;
  }

  // `--profile multica --stdio` is what Multica appends; the profile name is
  // irrelevant here because this process *is* the bridge.
  writeFrame({ type: "ready", runtime: "dsh" });

  let active = null;
  const done = () => {
    active = null;
  };

  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let command;
    try {
      command = JSON.parse(trimmed);
    } catch {
      writeFrame({
        type: "protocol_error",
        code: "BAD_COMMAND",
        message: `expected a JSON object, got: ${trimmed.slice(0, 200)}`,
      });
      return;
    }
    if (command.v !== undefined && command.v !== PROTOCOL_VERSION) {
      writeFrame({
        type: "protocol_error",
        code: "UNSUPPORTED_VERSION",
        message: `bridge speaks protocol v${PROTOCOL_VERSION}, got v${command.v}`,
      });
      return;
    }
    switch (command.type) {
      case "execute":
        if (active) {
          writeFrame({
            type: "result",
            request_id: command.request_id ?? "",
            status: "failed",
            error: { code: "BUSY", message: "a run is already in flight on this process" },
          });
          return;
        }
        active = runTurn(command, { onDone: done });
        return;
      case "cancel":
        active?.cancel();
        return;
      default:
        writeFrame({
          type: "protocol_error",
          code: "UNKNOWN_COMMAND",
          message: `unknown command type ${JSON.stringify(command.type)}`,
        });
    }
  });

  reader.on("close", () => {
    // Multica closes stdin when it gives up on the process; stop the child so
    // the run does not keep writing into a workspace nobody is watching.
    active?.cancel();
  });
}

main();
