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
    RIVERTON_APP_LOCAL_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

try {
  // 客户端有两个入口，生产构建必须两个都能服务端渲染出来：
  //
  //   /          公开落地页（营销入口，匿名可见）
  //   /dashboard 门户（登录后的工作台，未登录时渲染会话验证态）
  //
  // 原来这里只取 `/` 并断言「正在验证客户端会话」——那是 `/` 还渲染门户外壳时
  // 写的断言。ADR-0017 把 `/` 划给公开落地页之后这条就一直是红的（断言过时，
  // 不是回归）。现在两个入口分别断言各自应有的内容。
  const landingResponse = await waitForHtml(`http://127.0.0.1:${port}/`, child, () => logs);
  assert.match(landingResponse.headers.get("content-type") || "", /^text\/html\b/i);
  const landing = await landingResponse.text();
  assert.match(landing, /Riverton Capital/i);
  // 落地页的主视觉是七阶段决策链（ADR-0018）。服务端渲染出来才算数——
  // 只靠 <title> 无法区分「渲染成功」和「壳子返回了但内容没渲染」。
  assert.match(landing, /一支为你工作的 AI 量化团队/);
  assert.match(landing, /市场分析师/);
  // 落地页不得混入门户外壳：那会让匿名访客看到会话验证态而不是营销页。
  assert.doesNotMatch(landing, /正在验证客户端会话/);
  assert.doesNotMatch(landing, /name=["']codex-preview["']/i);

  const portalResponse = await waitForHtml(`http://127.0.0.1:${port}/dashboard`, child, () => logs);
  const portal = await portalResponse.text();
  assert.match(portal, /Riverton Capital/i);
  // 未登录访问门户路由应当渲染会话验证态，而不是把落地页当兜底。
  assert.match(portal, /正在验证客户端会话/);
  assert.doesNotMatch(portal, /一支为你工作的 AI 量化团队/);

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
