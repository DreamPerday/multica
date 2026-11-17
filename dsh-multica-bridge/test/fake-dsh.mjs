/**
 * Stand-in for `dsh --profile headless --json`, used to verify the bridge's
 * protocol translation without needing model credentials.
 *
 * Emits the exact event vocabulary from
 * @deepseek-ai/dsh-headless/lib/json-stream (projectJsonRun), then exits.
 */

const sessionId = process.argv.includes("--session-id")
  ? process.argv[process.argv.indexOf("--session-id") + 1]
  : "session-fake-0001";

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: "session", sessionId, cwd: process.cwd() });
emit({ type: "status", phase: "turn_start", turn: 1 });
emit({ type: "status", phase: "step_start", turn: 1, step: 1 });
emit({ type: "thinking", text: "thinking about the task" });
emit({ type: "text", text: "Hello from the fake dsh." });
emit({
  type: "tool_call",
  callId: "call-1",
  tool: "bash",
  input: { command: "echo hi" },
});
emit({
  type: "tool_result",
  callId: "call-1",
  status: "completed",
  result: "hi\n",
});
emit({
  type: "status",
  phase: "step_end",
  turn: 1,
  step: 1,
  usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 5, cacheWriteTokens: 0 },
});
emit({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "end_turn" } });
emit({ type: "final", text: "Hello from the fake dsh." });
