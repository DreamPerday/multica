/**
 * Drives the bridge exactly the way Multica's dsh backend does and asserts the
 * frames it writes back. Runs against test/fake-dsh.cmd, so it needs no model
 * credentials and no network.
 *
 *   node test/protocol.test.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bridge = join(here, "..", "bridge.mjs");
const fakeDsh = join(here, "fake-dsh.cmd");
const fakeScript = join(here, "fake-dsh.mjs");

let failures = 0;
const check = (condition, label, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};

/** Run the bridge through one execute command and collect its frames. */
function runBridge({ args = [], command, onFrame }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, ...args], {
      env: { ...process.env, DSH_BRIDGE_DSH_BINARY: fakeDsh, DSH_BRIDGE_FAKE_NODE: process.execPath, DSH_BRIDGE_FAKE_SCRIPT: fakeScript },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const frames = [];
    let buffer = "";
    let sawResult = false;

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          failures += 1;
          console.log(`  FAIL non-JSON stdout line — ${JSON.stringify(line.slice(0, 120))}`);
          continue;
        }
        frames.push(frame);
        onFrame?.(frame);
        if (frame.type === "result") {
          sawResult = true;
          child.stdin.end();
        }
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", () => resolve({ frames, stderr, sawResult }));

    if (command) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    } else {
      child.stdin.end();
    }

    setTimeout(() => {
      if (!sawResult && command) child.stdin.end();
    }, 15000);
  });
}

async function testModelCatalog() {
  console.log("\n--list-models");
  const { frames } = await runBridge({ args: ["--profile", "multica", "--list-models"] });
  const models = frames.find((frame) => frame.type === "models");
  check(Boolean(models), "emits a models frame");
  check(Array.isArray(models?.models) && models.models.length > 0, "catalog is non-empty", models?.models?.length);
  check(models?.models?.[0]?.id && models?.models?.[0]?.label, "first model has id and label", models?.models?.[0]);
  check(frames.every((frame) => frame.v === 1), "every frame carries v=1");
}

async function testExecute() {
  console.log("\nexecute");
  const requestId = "task-abc-123";
  const { frames, sawResult } = await runBridge({
    args: ["--profile", "multica", "--stdio"],
    command: {
      v: 1,
      type: "execute",
      request_id: requestId,
      cwd: process.cwd(),
      prompt: "say hi",
      mcp_servers: [],
    },
  });

  check(frames[0]?.type === "ready" && frames[0]?.runtime === "dsh", "first frame is ready with runtime=dsh", frames[0]);
  check(frames.every((frame) => frame.v === 1), "every frame carries v=1");
  check(sawResult, "terminated with a result frame");

  const session = frames.find((frame) => frame.type === "session");
  check(session?.session_id === "session-fake-0001", "session id translated", session?.session_id);
  check(session?.request_id === requestId, "session frame echoes request_id");

  const text = frames.find((frame) => frame.type === "text");
  check(text?.content === "Hello from the fake dsh.", "text content translated", text?.content);

  const thinking = frames.find((frame) => frame.type === "thinking");
  check(thinking?.content === "thinking about the task", "thinking content translated", thinking?.content);

  const toolCall = frames.find((frame) => frame.type === "tool_call");
  check(toolCall?.call_id === "call-1" && toolCall?.name === "bash", "tool_call id/name translated", toolCall);
  check(toolCall?.arguments === JSON.stringify({ command: "echo hi" }), "tool_call arguments are a JSON string", toolCall?.arguments);

  const toolResult = frames.find((frame) => frame.type === "tool_result");
  check(toolResult?.call_id === "call-1", "tool_result pairs with the call", toolResult?.call_id);
  check(toolResult?.name === "bash", "tool_result recovers the tool name from call_id", toolResult?.name);
  check(toolResult?.output === "hi\n", "tool_result output translated", toolResult?.output);

  const usage = frames.find((frame) => frame.type === "usage");
  check(usage?.input_tokens === 12 && usage?.output_tokens === 34, "usage translated", usage);
  check(usage?.cache_read_tokens === 5, "cache read tokens translated", usage?.cache_read_tokens);

  const result = frames.find((frame) => frame.type === "result");
  check(result?.status === "completed", "result status is succeeded", result?.status);
  check(result?.output === "Hello from the fake dsh.", "result output is the final text", result?.output);
  check(result?.session_id === "session-fake-0001", "result carries the session id", result?.session_id);
}

async function testUnsupportedVersion() {
  console.log("\nprotocol version guard");
  const { frames, sawResult } = await runBridge({
    command: { v: 99, type: "execute", request_id: "r1", prompt: "hi", cwd: process.cwd() },
    onFrame: (frame) => {
      if (frame.type === "protocol_error") {
        // Stop early: the bridge rejects the command instead of running it.
      }
    },
  });
  const error = frames.find((frame) => frame.type === "protocol_error");
  check(error?.code === "UNSUPPORTED_VERSION", "rejects a future protocol version", error);
  check(!sawResult, "does not emit a result for a rejected command");
}

async function testUnknownCommand() {
  console.log("\nunknown command");
  const { frames } = await runBridge({
    command: { v: 1, type: "nonsense", request_id: "r2" },
  });
  const error = frames.find((frame) => frame.type === "protocol_error");
  check(error?.code === "UNKNOWN_COMMAND", "reports UNKNOWN_COMMAND", error);
}

console.log("dsh-multica-bridge protocol tests");
console.log(`  bridge:   ${bridge}`);
console.log(`  fake dsh: ${fakeDsh}`);

await testModelCatalog();
await testExecute();
await testUnsupportedVersion();
await testUnknownCommand();

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
