/**
 * 对账任务。
 *
 * 跑在执行服务进程里，而不是单独的 Worker——查单需要客户凭证，而执行服务是全系统
 * 唯一能解密凭证的进程（ADR-0019 第 2 步）。再开一个进程就等于再多一个持有密钥的
 * 地方，把第 2 步刚收敛好的东西又散开。
 */

import type { Pool, PoolClient } from "pg";

import {
  DEFAULT_RECONCILIATION_POLICY,
  decideReconciliation,
  type ReconciliationObservation,
  type ReconciliationPolicy,
} from "../../../packages/domain/src/execution/reconciliation.ts";
import type { ExchangeCredential } from "../../exchange-credentials.ts";
import {
  applyReconciliationDecision,
  leaseDueReconciliation,
  type ReconciliationRow,
} from "./reconciliation-repository.ts";
import type { LiveOrderAdapter } from "./live-execution-port.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ReconciliationWorkerDependencies = {
  workerId: string;
  now(): Date;
  loadCredential(input: { accountId: string; customerId: string }): Promise<{ credentials: ExchangeCredential }>;
  adapterFor(exchange: string): LiveOrderAdapter | null;
  policy?: ReconciliationPolicy;
  leaseMs?: number;
};

export type ReconciliationOutcome =
  | { processed: false }
  | { processed: true; clientOrderId: string; action: "resolve" | "retry" | "escalate" };

export async function processNextReconciliation(
  database: Queryable,
  deps: ReconciliationWorkerDependencies,
): Promise<ReconciliationOutcome> {
  const now = deps.now();
  const row = await leaseDueReconciliation(database, {
    workerId: deps.workerId,
    now,
    leaseMs: deps.leaseMs ?? 60_000,
  });
  if (!row) return { processed: false };

  const observation = await observe(row, deps);
  const decision = decideReconciliation(
    row, observation, now.getTime(), deps.policy ?? DEFAULT_RECONCILIATION_POLICY,
  );
  const externalOrderId = observation.kind === "order_found" ? observation.externalOrderId ?? null : null;
  await applyReconciliationDecision(database, row, decision, now, externalOrderId);
  return { processed: true, clientOrderId: row.clientOrderId, action: decision.action };
}

type Observed = ReconciliationObservation & { externalOrderId?: string | null };

async function observe(row: ReconciliationRow, deps: ReconciliationWorkerDependencies): Promise<Observed> {
  const adapter = deps.adapterFor(row.exchange);
  // 适配器缺失是配置问题，不是「订单不存在」。绝不能因为我们这边少了个适配器就
  // 判定客户的单没下成——那会导致重复下单。
  if (!adapter) return { kind: "query_failed", reason: "EXCHANGE_ADAPTER_NOT_AVAILABLE" };

  try {
    const { credentials } = await deps.loadCredential({
      accountId: row.accountId,
      customerId: row.customerId,
    });
    const order = await adapter.getOrderByClientOrderId({
      credentials, symbol: row.symbol, clientOrderId: row.clientOrderId,
    });
    if (!order) return { kind: "order_absent" };
    return {
      kind: "order_found",
      state: order.state,
      filledQuantity: order.filledQuantity,
      averagePrice: order.averagePrice,
      externalOrderId: order.externalOrderId,
    };
  } catch (error) {
    // 查询失败一律归为 query_failed，由状态机决定重试还是升级。
    // **不在这里推断订单状态**——不确定的时候不能假装确定（INV-7）。
    return { kind: "query_failed", reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

/** 循环处理直到没有到期的任务。返回本轮处理条数。 */
export async function drainReconciliations(
  database: Queryable,
  deps: ReconciliationWorkerDependencies,
  maxBatch = 50,
): Promise<number> {
  let processed = 0;
  while (processed < maxBatch) {
    const result = await processNextReconciliation(database, deps);
    if (!result.processed) break;
    processed += 1;
  }
  return processed;
}
