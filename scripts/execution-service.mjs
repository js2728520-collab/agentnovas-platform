/**
 * 执行服务进程（ADR-0019 第 2 步）。
 *
 * 这是全系统**唯一**持有 EXCHANGE_CREDENTIAL_ENCRYPTION_KEY 的进程。
 * 三个 Web 应用都不再需要那个环境变量，公网盒子被攻破也无法还原任何客户的
 * 交易所凭证。
 *
 * 部署要求：
 *   - 只监听回环地址或内网地址，**绝不暴露到公网**（Nginx 不为它配 server 块）。
 *   - 与 Web 分开的 systemd unit、分开的 .env、分开的文件权限。
 *   - EXECUTION_SERVICE_SHARED_SECRET 与凭证加密密钥是两把不同的密钥，分开轮换。
 */

import { createServer } from "node:http";
import os from "node:os";

import pg from "pg";

import {
  assertExecutionSecretConfigured,
  dispatchExecutionRequest,
  EXECUTION_AUTH_HEADER,
  isAuthorizedExecutionRequest,
  toPublicExecutionError,
} from "../lib/execution/server/handler.ts";
import { loadExchangeCredential } from "../lib/execution/server/credential-access.ts";
import { createBinanceOrderAdapter } from "../lib/execution/server/binance-adapter.ts";
import { createOkxOrderAdapter } from "../lib/execution/server/okx-adapter.ts";
import { drainReconciliations } from "../lib/execution/server/reconciliation-worker.ts";

const port = Number(process.env.EXECUTION_SERVICE_PORT ?? 3020);
const host = process.env.EXECUTION_SERVICE_HOST ?? "127.0.0.1";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

// 配置缺失时拒绝启动，而不是「没配就不鉴权」地放行。
const secret = assertExecutionSecretConfigured(process.env.EXECUTION_SERVICE_SHARED_SECRET);
if (!process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY) {
  throw new Error("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY 缺失：执行服务是唯一能解密凭证的进程，没有它无事可做");
}
// 绑通配地址需要运维显式声明「本进程只在内网可达」。
//
// 这个端口等价于「替任何客户下单」的能力，所以默认拒绝通配地址。但容器部署里
// 回环地址对同网络的其它容器不可达，一律拒绝会让执行服务在 compose 下根本用不了
// ——那正是这份配置此前与文档互相矛盾的地方。
//
// 做成一个具名断言而不是静默放行：它写在 env 文件里（可审计）、启动时大声打印
// （可发现），默认仍然是拒绝。运维做出这个断言的前提是：
//   容器没有 ports 映射、不在 edge 网络上，或裸机上有防火墙挡住该端口。
const internalNetworkOnly = process.env.EXECUTION_SERVICE_INTERNAL_NETWORK_ONLY === "true";
if ((host === "0.0.0.0" || host === "::") && !internalNetworkOnly) {
  throw new Error(
    `拒绝监听 ${host}：执行服务只能绑回环地址。\n` +
    "容器部署确需绑通配地址时，设置 EXECUTION_SERVICE_INTERNAL_NETWORK_ONLY=true，\n" +
    "前提是该容器没有 ports 映射且不在 edge 网络上——这个端口等价于「替任何客户下单」。",
  );
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    // 健康检查不鉴权，也不透露任何配置——只回答「进程活着吗」。
    return sendJson(response, 200, { status: "ready", timestamp: new Date().toISOString() });
  }
  if (request.method !== "POST" || request.url !== "/execute") {
    return sendJson(response, 404, { ok: false, code: "NOT_FOUND", message: "未知端点" });
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    sendJson(response, 413, { ok: false, code: "REQUEST_TOO_LARGE", message: "请求体过大" });
    request.destroy();
    return;
  }
  if (!isAuthorizedExecutionRequest(request.headers[EXECUTION_AUTH_HEADER], secret)) {
    // 不记录提供的密钥值，也不区分「没带」和「带错了」。
    console.error(`[execution] 拒绝未授权请求 from=${request.socket.remoteAddress}`);
    return sendJson(response, 401, { ok: false, code: "UNAUTHORIZED", message: "内网鉴权失败" });
  }

  const chunks = [];
  let bodyBytes = 0;
  let bodyTooLarge = false;
  const bodyTimer = setTimeout(() => {
    if (!request.complete) {
      bodyTooLarge = true;
      sendJson(response, 408, { ok: false, code: "REQUEST_BODY_TIMEOUT", message: "请求体读取超时" });
      request.destroy();
    }
  }, BODY_READ_TIMEOUT_MS);
  request.on("data", (chunk) => {
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_REQUEST_BODY_BYTES && !bodyTooLarge) {
      bodyTooLarge = true;
      sendJson(response, 413, { ok: false, code: "REQUEST_TOO_LARGE", message: "请求体过大" });
      request.destroy();
      return;
    }
    if (!bodyTooLarge) chunks.push(chunk);
  });
  request.on("error", () => clearTimeout(bodyTimer));
  request.on("end", async () => {
    clearTimeout(bodyTimer);
    if (bodyTooLarge) return;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return sendJson(response, 400, { ok: false, code: "BAD_REQUEST", message: "请求体不是合法 JSON" });
    }
    try {
      const result = await dispatchExecutionRequest(parsed);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      // 详细原因只进本进程日志；回给 Web 层的是白名单化的错误身份。
      console.error(`[execution] operation=${parsed?.operation ?? "unknown"} failed:`,
        error instanceof Error ? error.stack ?? error.message : error);
      sendJson(response, 200, { ok: false, ...toPublicExecutionError(error) });
    }
  });
});

server.headersTimeout = 10_000;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.timeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.log(`[execution] 执行服务已启动 http://${host}:${port}（唯一持有凭证解密能力的进程）`);
  if (internalNetworkOnly) {
    // 大声说出来：这条断言的正确性由部署拓扑保证，代码无法自行验证。
    console.warn(
      "[execution] 已按 EXECUTION_SERVICE_INTERNAL_NETWORK_ONLY=true 绑定通配地址。" +
      "请确认本进程没有对外发布端口，且不在面向公网的网络上。",
    );
  }
});

// ---------------------------------------------------------------------------
// 对账循环。
//
// 它跑在这个进程里而不是单独的 Worker，因为查单需要客户凭证，而本进程是全系统
// 唯一能解密凭证的地方。再开一个进程就等于再多一个持有密钥的地方，把第 2 步刚
// 收敛好的东西又散开。

const reconciliationPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.EXECUTION_RECONCILIATION_POOL_SIZE || 2),
  application_name: "agentnovas-execution-reconciliation",
});

// 适配器一律默认 demo。是否走实盘由 execution_live_routing 的显式授权决定，
// 不由这里的默认值决定——一个默认为 live 的适配器等于把授权闸门绕过去。
const adapters = new Map([
  ["okx", createOkxOrderAdapter()],
  ["binance", createBinanceOrderAdapter()],
]);
const reconciliationDeps = {
  workerId: `${os.hostname().replace(/[^a-z0-9.-]/gi, "-").slice(0, 60)}-${process.pid}`,
  now: () => new Date(),
  loadCredential: (input) => loadExchangeCredential(input),
  adapterFor: (exchange) => adapters.get(exchange.toLowerCase()) ?? null,
};

const RECONCILIATION_INTERVAL_MS = Number(process.env.EXECUTION_RECONCILIATION_INTERVAL_MS || 15_000);
let reconciliationTimer = null;
let stopping = false;

async function runReconciliationSweep() {
  if (stopping) return;
  try {
    const processed = await drainReconciliations(reconciliationPool, reconciliationDeps);
    if (processed > 0) console.log(`[execution] 对账处理 ${processed} 条`);
  } catch (error) {
    // 对账失败不能让进程退出——下单接口还要继续服务。
    console.error("[execution] 对账循环出错:", error instanceof Error ? error.message : error);
  } finally {
    if (!stopping) reconciliationTimer = setTimeout(runReconciliationSweep, RECONCILIATION_INTERVAL_MS);
  }
}

if (process.env.EXECUTION_RECONCILIATION_ENABLED !== "false") {
  reconciliationTimer = setTimeout(runReconciliationSweep, RECONCILIATION_INTERVAL_MS);
  console.log(`[execution] 对账循环已启用，每 ${RECONCILIATION_INTERVAL_MS}ms 扫一次`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (reconciliationTimer) clearTimeout(reconciliationTimer);
    server.close(async () => {
      await reconciliationPool.end().catch(() => {});
      process.exit(0);
    });
  });
}
