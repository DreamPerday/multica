# dsh-multica-bridge

Lets **Multica** drive **DeepSeek Harness** — the missing piece upstream has not
shipped yet.

## Why this exists

Multica's `dsh` provider launches `dsh --profile multica --stdio` and speaks a
versioned JSONL protocol on that process's stdio. That profile is supposed to
come from an `@multica-ai/dsh-runtime` bundle, which **is not published to npm**
(upstream: `multica#6936`). Without it the daemon refuses to register a runtime:

```
WRN skip registering runtime: DSH Multica runtime profile is not installed
```

This bridge closes the gap from the outside. It never touches DSH's profile
store — instead it is registered as a **custom runtime profile** in Multica, so
Multica launches *this* process and the bridge spawns DSH itself:

```
Multica daemon ──spawn──▶ dsh-multica-bridge ──spawn──▶ DSH Desktop.exe --expose-internals desktop-cli.js
                           (Multica JSONL)                     --profile headless --json -
                                                                     │
                           (translated frames) ◀──────────────────────┘
```

The translation target is `dsh --profile headless --json`, DSH's own
newline-delimited run-event mode, whose vocabulary is defined by
`@deepseek-ai/dsh-headless/lib/json-stream`.

## Install

1. Put this directory on `PATH` (the daemon resolves `dsh-multica-bridge` there):

   ```powershell
   [Environment]::SetEnvironmentVariable(
     "Path",
     [Environment]::GetEnvironmentVariable("Path", "User") + ";D:\养猪\Multica Android\dsh-multica-bridge",
     "User")
   ```

2. Register it as a custom runtime profile:

   ```powershell
   multica runtime profile create `
     --command-name dsh-multica-bridge `
     --protocol-family dsh `
     --display-name "DeepSeek Harness (bridge)"
   ```

3. Start (or restart) the daemon:

   ```powershell
   multica daemon restart
   multica runtime list
   ```

## Tests

```powershell
node test/protocol.test.mjs     # protocol contract, against a fake dsh
node test/live-probe.mjs "你好"  # end to end against the real dsh
```

`protocol.test.mjs` drives the bridge exactly the way Multica's `dsh.go` does
and asserts 24 properties of the frame stream: `ready` first with
`runtime:"dsh"`, `v:1` on every frame, session/text/thinking/tool_call/
tool_result/usage/result translation, `call_id` pairing, and the version guard.

## Frame mapping

| DSH run event (`--json`) | Multica frame |
|---|---|
| — (process start) | `{type:"ready", runtime:"dsh"}` |
| `{type:"session", sessionId}` | `{type:"session", session_id}` |
| `{type:"text", text}` | `{type:"text", content}` |
| `{type:"thinking", text}` | `{type:"thinking", content}` |
| `{type:"tool_call", callId, tool, input}` | `{type:"tool_call", call_id, name, arguments}` |
| `{type:"tool_result", callId, status, result}` | `{type:"tool_result", call_id, name, output}` |
| `{type:"status", phase:"step_end", usage}` | `{type:"usage", input_tokens, ...}` |
| `{type:"final", text}` | `{type:"result", status:"succeeded", output}` |
| `status.phase == turn_end` with `reason.kind == "error"` | `{type:"result", status:"failed", error:{code,message}}` |

## What DSH exposes, and what it does not

`dsh --profile headless` accepts only three things: `--json`, `--session-id`,
and the task text (`-` reads stdin). That shapes every limitation below.

- **Model selection is ignored.** Multica may send `model.provider/id` and
  `reasoning_effort`; `headless` has no flag to honour them, so the run uses
  whatever the profile is configured for. The bridge advertises a single model
  (`DSH_BRIDGE_MODEL_ID`, default `deepseek-v4.1-flash`) to match.
- **MCP servers are ignored.** Multica sends `mcp_servers`; DSH reads its own
  MCP configuration, and `headless` offers no override.
- **The task travels on stdin, not argv.** A prompt is arbitrary text, and
  quoting it through a Windows command line breaks on this project's path (it
  contains a space).
- **`--list-models` is answered by the bridge**, not by DSH — the flag does not
  exist on `headless`.

## Requirements and failure modes

- **The sandbox must be off for shell work to be possible.** `dsh-base` sets
  `sandbox-policy.mode` from `DSH_PERMISSION_MODE`, defaulting to
  `workspace-write`. On this machine **both confined modes
  (`workspace-write` and `read-only`) run commands but discard their stdout**:
  `Write-Output abcdef` comes back as `"\r\n"`, exit code 0, `is_error: false`.
  An agent sees an empty result for every command and reports that its shell is
  broken. Only `danger-full-access` captures output correctly. This matches the
  harness's own documented boundary — confined processes cannot open named
  pipes, so capturing another program's stdio fails.

  The bridge therefore sets `DSH_PERMISSION_MODE=danger-full-access` for the
  child unless `DSH_BRIDGE_PERMISSION_MODE` overrides it.

  **Trade-off, stated plainly:** in that mode a dispatched agent can read any
  file the daemon's user can read. A run started to check `Get-Date` was
  observed reading stored tokens. Treat "who can dispatch to this agent" as "who
  can read this account's files", and either keep the agent private, run the
  daemon under a separate low-privilege Windows account, or scope the workspace
  root to a directory with nothing sensitive above it.

- **Model credentials.** The `headless` profile resolves model access on its
  own. A DeepSeek Account sign-in (what DSH Desktop's UI uses) is *not* visible
  to it. `dsh-base` also hardcodes `agent-default-model` to the built-in
  `deepseek-official` route, which needs `DEEPSEEK_API_KEY`. The bridge passes
  `model-route.yml` via `--patch` to point that default at a route CC-Switch
  already provisioned (`cc-switch-open-code-go`), whose key lives in DSH's
  credential store. Without this every run ends:

  ```
  MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
  ```

- **`--patch` must precede `--profile`.** It is a launcher flag; given after
  `--profile`, the headless app answers `unknown option '--patch'` because the
  remaining argv is forwarded to the app untouched.


- **Never spawn the `.cmd` shim directly.** `shell: true` concatenates an
  unescaped command line and splits this project's path on its space; a plain
  `spawn` of a batch file fails with `EINVAL`; routing through `cmd.exe`
  mangles the non-ASCII install path (`D:\应用软件\…`). The bridge therefore
  *parses* the shim (`resolveDshLaunch` / `parseBatchShim`) and spawns the real
  `DSH Desktop.exe` with its `--expose-internals <desktop-cli.js>` prefix and
  the `ELECTRON_RUN_AS_NODE` / `DSH_HOME` environment the shim would have set.

- **The shim must stay pure ASCII.** `cmd.exe` reads it under the OEM codepage;
  a non-ASCII byte sequence makes it mis-parse the following lines.

- **Closing stdin cancels the run.** Multica keeps stdin open until the process
  exits, so this is the abandonment signal.
