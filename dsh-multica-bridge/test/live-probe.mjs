/** Drive the bridge against the REAL dsh and print every frame.
 *
 * Keeps stdin open until a result frame arrives, which is how Multica behaves —
 * closing stdin early makes the bridge cancel the run.
 *
 *   node test/live-probe.mjs "你的任务"
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const prompt = process.argv[2] ?? "回答两个字：收到";
// Third argument lets the probe run in a Multica task workdir, which is where
// the sandbox behaves differently from a plain project directory.
const probeCwd = process.argv[3] ?? "D:\\养猪";

const child = spawn(process.execPath, [join(here, "..", "bridge.mjs"), "--profile", "multica", "--stdio"], {
  cwd: probeCwd,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  child.stdin.end();
  setTimeout(() => process.exit(code), 300);
};

const reader = (stream, tag) => {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      console.log(`${tag} ${line}`);
      if (tag === "OUT") {
        try {
          if (JSON.parse(line).type === "result") finish(0);
        } catch {
          /* keep going */
        }
      }
    }
  });
};
reader(child.stdout, "OUT");
reader(child.stderr, "ERR");

child.on("close", (code) => {
  console.log(`bridge exited ${code}`);
  finish(0);
});

child.stdin.write(
  `${JSON.stringify({
    v: 1,
    type: "execute",
    request_id: "live-probe-1",
    cwd: probeCwd,
    prompt,
    mcp_servers: [],
  })}\n`,
);

setTimeout(() => {
  console.log("--- timeout, cancelling ---");
  child.stdin.write(`${JSON.stringify({ v: 1, type: "cancel", request_id: "live-probe-1" })}\n`);
  finish(1);
}, 180000);
