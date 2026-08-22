/**
 * 实盘下单的服务端入口：组装真实依赖、执行、落回执。
 *
 * 这是「执行端接进决策扇出」的接线点。Worker 只产出决策与翻译好的订单意图，
 * 通过内网调用走到这里；凭证解密、限流、熔断、对账登记全部发生在本进程
 * （ADR-0019）。
 */

import type { Pool } from "pg";

import type { ExecutionReceipt } from "../../../packages/domain/src/execution/execution-port.ts";
import type { OrderIntent } from "../../../packages/domain/src/execution/order-intent.ts";
import type { ExecutionProduct } from "../../../packages/domain/src/execution/live-routing.ts";
import { listActiveKillSwitches } from "../kill-switch-repository.ts";
import { listLiveRoutingGrants } from "../live-routing-repository.ts";
import { loadExchangeCredential } from "./credential-access.ts";
import { createBinanceOrderAdapter } from "./binance-adapter.ts";
import { createOkxOrderAdapter } from "./okx-adapter.ts";
import { createLiveExecutionPort, type LiveOrderAdapter } from "./live-execution-port.ts";
import { createRateLimitPool, type RateLimitPool } from "./rate-limit-pool.ts";
import { enqueueReconciliation } from "./reconciliation-repository.ts";
import { loadAccountReconciliationState } from "./reconciliation-repository.ts";

export type ExecuteOrderIntentInput = {
  deploymentId: string;
  customerId: string;
  accountId: string;
  portfolioId: string;
  intent: OrderIntent;
  availableCapital: number;
  capitalCapRatio: number;
  executionProduct: ExecutionProduct;
  runtimeCycleId?: string | null;
  traceId?: string | null;
};

// 限流池的桶状态必须在进程内长存，每次调用新建等于没有限流。
let sharedRateLimiter: RateLimitPool | null = null;
function rateLimiter(): RateLimitPool {
  if (!sharedRateLimiter) sharedRateLimiter = createRateLimitPool();
  return sharedRateLimiter;
}

/**
 * 适配器按 (交易所, 环境) 建。
 *
 * OKX 目前只有模拟盘实现（`okx-demo-execution.ts` 硬写 x-simulated-trading: 1），
 * 所以 okx/live 返回 null——**宁可明确报「该环境没有适配器」，也不要把 live 账户
 * 静默发到模拟盘端点**，那会让客户以为自己有实盘仓位而交易所里是模拟仓位。
 */
function adapterKey(exchange: string, environment: "demo" | "live") {
  return `${exchange.toLowerCase()}:${environment}`;
}

const adapters = new Map<string, LiveOrderAdapter>([
  [adapterKey("okx", "demo"), createOkxOrderAdapter()],
  [adapterKey("binance", "demo"), createBinanceOrderAdapter({ environment: "demo" })],
  [adapterKey("binance", "live"), createBinanceOrderAdapter({ environment: "live" })],
]);

export async function executeOrderIntent(
  database: Pool,
  input: ExecuteOrderIntentInput,
): Promise<ExecutionReceipt> {
  const port = createLiveExecutionPort({
    async resolveAccount() {
      // 账户由调用方指定，但归属仍在本进程校验：Worker 被攻破时这一层仍然挡住
      // 「替别的客户下单」。与紧急平仓那条路径同一个理由。
      const row = (await database.query<{ id: string; customer_id: string; exchange: string; environment: string }>(
        `SELECT id, customer_id, exchange, environment FROM exchange_accounts
         WHERE id = $1 AND customer_id = $2 AND status = 'active' AND can_trade = true`,
        [input.accountId, input.customerId],
      )).rows[0];
      if (!row) return null;
      return {
        accountId: row.id,
        customerId: row.customer_id,
        exchange: row.exchange,
        environment: row.environment === "live" ? "live" : "demo",
      };
    },
    loadCredential: (credentialInput) => loadExchangeCredential(credentialInput),
    adapterFor: (exchange, environment) => adapters.get(adapterKey(exchange, environment)) ?? null,
    rateLimiter: rateLimiter(),
    now: () => new Date(),
    loadReconciliationState: (accountId) => loadAccountReconciliationState(database, accountId),
    loadActiveKillSwitches: () => listActiveKillSwitches(database),
    loadLiveRoutingGrants: () => listLiveRoutingGrants(database),
    executionProduct: input.executionProduct,
    async enqueueReconciliation(reconciliation) {
      await enqueueReconciliation(database, { ...reconciliation, now: new Date() });
    },
  });

  const [receipt] = await port.execute([{
    intent: input.intent,
    portfolioId: input.portfolioId,
    availableCapital: input.availableCapital,
    capitalCapRatio: input.capitalCapRatio,
  }]);

  await persistReceipt(database, input, receipt);
  return receipt;
}

/**
 * 落回执。
 *
 * `ON CONFLICT (intent_id) DO NOTHING`：同一条意图只留一条回执。重放同一轮决策
 * 必须幂等（INV-8），而重放确实会发生——Worker 崩溃重启就会。
 *
 * 落库失败不吞：回执是绩效分成的依据，一条丢掉的成交回执意味着客户的仓位在系统里
 * 不存在。宁可让调用方看到错误并进入对账，也不要静默丢失。
 */
async function persistReceipt(
  database: Pool,
  input: ExecuteOrderIntentInput,
  receipt: ExecutionReceipt,
): Promise<void> {
  await database.query(
    `INSERT INTO live_execution_receipts (
       id, deployment_id, customer_id, exchange_account_id, decision_round_id,
       runtime_cycle_id, intent_id, trace_id, symbol, side, outcome,
       filled_quantity, average_price, fee_amount, rejection_reason,
       external_order_id, executed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (intent_id) DO NOTHING`,
    [
      crypto.randomUUID(), input.deploymentId, input.customerId, input.accountId,
      input.intent.provenance.decisionRoundId, input.runtimeCycleId ?? null,
      receipt.intentId, input.traceId ?? null, input.intent.symbol, input.intent.side,
      receipt.outcome, receipt.filledQuantity, receipt.averagePrice, receipt.feeAmount,
      receipt.rejectionReason, receipt.externalOrderId, receipt.executedAt,
    ],
  );
}
