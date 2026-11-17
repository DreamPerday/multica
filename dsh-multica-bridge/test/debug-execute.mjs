/** Manual driver to see bridge stderr for one execute command. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "..", "bridge.mjs"), "--profile", "multica", "--stdio"], {
  env: { ...process.env, DSH_BRIDGE_DSH_BINARY: join(here, "fake-dsh.cmd") },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

child.stdout.on("data", (chunk) => process.stdout.write(`OUT ${chunk}`));
child.stderr.on("data", (chunk) => process.stdout.write(`ERR ${chunk}`));
child.on("close", (code) => console.log(`closed ${code}`));

child.stdin.write(
  JSON.stringify({
    v: 1,
    type: "execute",
    request_id: "task-abc-123",
    cwd: process.cwd(),
    prompt: "say hi",
    mcp_servers: [],
  }) + "\n",
);

setTimeout(() => child.stdin.end(), 8000);
