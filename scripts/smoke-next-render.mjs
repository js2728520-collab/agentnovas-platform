import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHtml(url, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next.js exited before smoke verification.\n${output()}`);
    try {
      const response = await fetch(url, { headers: { accept: "text/html" } });
      if (response.ok) return response;
    } catch {
      // The production server can take a moment to bind after the process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}.\n${output()}`);
}

const port = await availablePort();
assert.equal(typeof port, "number");
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
let logs = "";
const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    NODE_ENV: "production",
    RIVERTON_APP_AUDIENCE: "client",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

try {
  const response = await waitForHtml(`http://127.0.0.1:${port}/`, child, () => logs);
  assert.match(response.headers.get("content-type") || "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Riverton Capital/i);
  assert.match(html, /交易大厅|Trading Hall/i);
  assert.doesNotMatch(html, /name=["']codex-preview["']/i);
  console.log(`Client production HTML smoke passed on port ${port}.`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
