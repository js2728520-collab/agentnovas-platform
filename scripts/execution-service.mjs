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
import { createOkxOrderAdapter } from "../lib/execution/server/okx-adapter.ts";
import { drainReconciliations } from "../lib/execution/server/reconciliation-worker.ts";

const port = Number(process.env.EXECUTION_SERVICE_PORT ?? 3020);
const host = process.env.EXECUTION_SERVICE_HOST ?? "127.0.0.1";

// 配置缺失时拒绝启动，而不是「没配就不鉴权」地放行。
const secret = assertExecutionSecretConfigured(process.env.EXECUTION_SERVICE_SHARED_SECRET);
if (!process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY) {
  throw new Error("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY 缺失：执行服务是唯一能解密凭证的进程，没有它无事可做");
}
if (host === "0.0.0.0" || host === "::") {
  // 这不是洁癖：这个端口等价于「替任何客户下单」的能力。
  throw new Error(`拒绝监听 ${host}：执行服务只能绑回环或明确的内网地址`);
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
  if (!isAuthorizedExecutionRequest(request.headers[EXECUTION_AUTH_HEADER], secret)) {
    // 不记录提供的密钥值，也不区分「没带」和「带错了」。
    console.error(`[execution] 拒绝未授权请求 from=${request.socket.remoteAddress}`);
    return sendJson(response, 401, { ok: false, code: "UNAUTHORIZED", message: "内网鉴权失败" });
  }

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
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

server.listen(port, host, () => {
  console.log(`[execution] 执行服务已启动 http://${host}:${port}（唯一持有凭证解密能力的进程）`);
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

const adapters = new Map([["okx", createOkxOrderAdapter()]]);
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
