import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  applyOfficialPaperFill,
  followPaperBookContract,
  type OfficialPaperPortfolioState,
} from "../packages/domain/src/official-paper-portfolio.ts";

/**
 * 社区策略跟单的模拟成交账本（T4.4 第 1 步）。
 *
 * 与 `official-paper-repository.ts` 是同一套流程：意图入库 → 下一根 K 线按真实行情价结算。
 * **记账算法共用域层那一份**，这里只负责读写——表可以分开，算法不能分开，否则两边的盈亏
 * 口径迟早分叉（INV-5）。
 */

type PortfolioRow = {
  id: string; customer_id: string; strategy_id: string; access_status: OfficialPaperPortfolioState["access"];
  principal_usdt: string; cash_usdt: string;
  realized_gross_pnl_usdt: string; realized_net_pnl_usdt: string; fees_usdt: string;
  capital_pct: number; risk_json: Record<string, unknown>;
};

/** 平台侧的操作护栏。不是客户同意过的条款，因此显式写在这里而不是藏进域层默认值。 */
export const FOLLOW_PAPER_GUARDRAILS = Object.freeze({
  maxTotalAllocationPct: 60,
  maxConcurrentAssets: 3,
  maxNewEntriesPerDay: 5,
});

function contractFor(portfolio: PortfolioRow, symbols: readonly string[]) {
  // 每单占比来自跟单合同的风险参数快照——客户当初同意的那个数字。
  const capitalPct = Number(portfolio.risk_json?.capitalPct ?? portfolio.capital_pct);
  return followPaperBookContract({
    symbols,
    capitalPct,
    ...FOLLOW_PAPER_GUARDRAILS,
  });
}

/**
 * 记录一笔跟单模拟订单意图。
 *
 * 幂等按 `idempotency_key` 判定——同一决策轮重跑必须落在同一行上，否则一次决策会记两笔
 * 成交，而模拟盘的盈亏正是绩效分成的计算基础。
 */
export async function recordFollowPaperOrderIntent(database: Pool, input: {
  deploymentId: string;
  portfolioId: string;
  runtimeCycleId: string;
  idempotencyKey: string;
  symbol: string;
  action: "buy" | "sell";
  timing: "next_candle_open" | "intrabar_threshold";
  requestedPrice: number | null;
  shadow: boolean;
  payload: Record<string, unknown>;
}) {
  const result = await database.query<{ id: string; status: string }>(`
    INSERT INTO strategy_follow_paper_order_intents (
      id, portfolio_id, deployment_id, runtime_cycle_id, idempotency_key,
      symbol, action, execution_timing, requested_price, status, payload_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING id, status
  `, [
    randomUUID(), input.portfolioId, input.deploymentId, input.runtimeCycleId, input.idempotencyKey,
    input.symbol, input.action, input.timing, input.requestedPrice,
    // shadow 模式只登记不成交：它的用途是验证决策链，不产生任何盈亏。
    input.shadow ? "shadowed" : "pending",
    JSON.stringify(input.payload),
  ]);
  return result.rows[0];
}

/**
 * 结算一笔待成交的跟单模拟订单。
 *
 * 与官方卡同样的两段式：先按 (部署, timing) 取一笔 pending 意图并锁住组合，再用域层的
 * `applyOfficialPaperFill` 算出新状态并落库。域层拒绝（超限、品种不在合同内、现金不足）
 * 时把意图标 rejected 并记下原因——**不是静默跳过**：一笔没被执行也没被拒绝的意图会永远
 * 留在队列里，下一轮再被取出来。
 */
export async function settlePendingFollowPaperOrder(database: Pool, input: {
  deploymentId: string;
  fillPrice?: number;
  fillTime: Date;
  timing: "next_candle_open" | "intrabar_threshold";
  traceId: string;
}) {
  if (input.fillPrice !== undefined && (!Number.isFinite(input.fillPrice) || input.fillPrice <= 0)) {
    throw new Error("跟单模拟成交价格无效");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const portfolio = (await client.query<PortfolioRow>(`
      SELECT portfolio.id, portfolio.customer_id, portfolio.strategy_id, portfolio.access_status,
             portfolio.principal_usdt, portfolio.cash_usdt,
             portfolio.realized_gross_pnl_usdt, portfolio.realized_net_pnl_usdt, portfolio.fees_usdt,
             subscription.capital_pct,
             COALESCE(contract.risk_json, '{}'::jsonb) AS risk_json
        FROM strategy_follow_paper_portfolios AS portfolio
        JOIN strategy_deployments AS deployment ON deployment.follow_paper_portfolio_id = portfolio.id
        JOIN strategy_subscriptions AS subscription ON subscription.id = portfolio.subscription_id
        LEFT JOIN strategy_follow_contracts AS contract ON contract.subscription_id = portfolio.subscription_id
       WHERE deployment.id = $1
       FOR UPDATE OF portfolio, subscription
    `, [input.deploymentId])).rows[0];
    if (!portfolio) {
      await client.query("COMMIT");
      return null;
    }

    const intent = (await client.query<{
      id: string; symbol: string; action: "buy" | "sell";
      requested_price: string | null; payload_json: Record<string, unknown>;
    }>(`
      SELECT id, symbol, action, requested_price, payload_json
        FROM strategy_follow_paper_order_intents
       WHERE deployment_id = $1 AND portfolio_id = $3
         AND status = 'pending' AND execution_timing = $2
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED LIMIT 1
    `, [input.deploymentId, input.timing, portfolio.id])).rows[0];
    if (!intent) {
      await client.query("COMMIT");
      return null;
    }

    const positions = await client.query<{
      id: string; symbol: string; quantity: string; average_entry_price: string;
      cost_basis_usdt: string; entry_fees_usdt: string;
    }>(`
      SELECT id, symbol, quantity, average_entry_price, cost_basis_usdt, entry_fees_usdt
        FROM strategy_follow_paper_positions
       WHERE portfolio_id = $1 AND status = 'open'
       ORDER BY opened_at, id FOR UPDATE
    `, [portfolio.id]);
    const fills = await client.query<{ action: string; symbol: string; filled_at: Date }>(`
      SELECT action, symbol, filled_at FROM strategy_follow_paper_fill_receipts
       WHERE portfolio_id = $1 ORDER BY filled_at, id
    `, [portfolio.id]);

    // 可交易品种取自当前持仓与本次意图。合同里没有独立的品种清单——策略交易什么由它的
    // DSL 决定，这里只需要让记账认得这些品种。
    const symbols = [...new Set([...positions.rows.map((row) => row.symbol), intent.symbol])];
    const state: OfficialPaperPortfolioState = {
      strategyCode: null,
      contract: contractFor(portfolio, symbols),
      access: portfolio.access_status,
      principalUsdt: Number(portfolio.principal_usdt),
      cashUsdt: Number(portfolio.cash_usdt),
      equityUsdt: Number(portfolio.cash_usdt)
        + positions.rows.reduce((sum, row) => sum + Number(row.cost_basis_usdt), 0),
      realizedGrossPnlUsdt: Number(portfolio.realized_gross_pnl_usdt),
      realizedNetPnlUsdt: Number(portfolio.realized_net_pnl_usdt),
      realizedPnlUsdt: Number(portfolio.realized_net_pnl_usdt),
      unrealizedPnlUsdt: 0,
      feesUsdt: Number(portfolio.fees_usdt),
      positions: positions.rows.map((row) => ({
        symbol: row.symbol,
        side: "long" as const,
        quantity: Number(row.quantity),
        averageEntryPrice: Number(row.average_entry_price),
        costBasisUsdt: Number(row.cost_basis_usdt),
        entryFeesUsdt: Number(row.entry_fees_usdt),
        marketPrice: Number(row.average_entry_price),
        marketValueUsdt: Number(row.cost_basis_usdt),
        unrealizedPnlUsdt: 0,
      })),
      // 只有 filledAt 与 action 参与 maxNewEntriesPerDay 计数，其余字段补零即可。
      fills: fills.rows.map((row) => ({
        action: row.action as "buy" | "sell",
        symbol: row.symbol,
        quantity: 0, fillPrice: 0, notionalUsdt: 0, feeUsdt: 0,
        allocatedEntryFeeUsdt: 0, realizedGrossPnlUsdt: 0, realizedNetPnlUsdt: 0,
        filledAt: row.filled_at.toISOString(),
      })),
    };

    const fillPrice = input.fillPrice ?? Number(intent.requested_price);
    const openPosition = state.positions.find((position) => position.symbol === intent.symbol);
    let next: OfficialPaperPortfolioState;
    try {
      next = applyOfficialPaperFill(state, {
        action: intent.action,
        symbol: intent.symbol,
        fillPrice,
        quoteAmountUsdt: intent.action === "buy" ? Number(intent.payload_json.quoteAmountUsdt) : undefined,
        quantity: intent.action === "sell" ? openPosition?.quantity : undefined,
        feeRate: Number(intent.payload_json.feeRate ?? 0.001),
        filledAt: input.fillTime.toISOString(),
      });
    } catch (error) {
      // 记下拒绝原因再提交。静默跳过会让这笔意图永远留在队列里被反复取出。
      await client.query(`
        UPDATE strategy_follow_paper_order_intents
           SET status='rejected', rejection_code=$2
         WHERE id=$1
      `, [intent.id, (error instanceof Error ? error.message : "记账拒绝").slice(0, 120)]);
      await client.query("COMMIT");
      return { intentId: intent.id, status: "rejected" as const };
    }

    const receipt = next.fills.at(-1)!;
    const positionRow = await upsertPosition(client, portfolio.id, intent.symbol, next, input.fillTime);
    await client.query(`
      INSERT INTO strategy_follow_paper_fill_receipts (
        id, intent_id, portfolio_id, position_id, symbol, action, quantity, fill_price,
        notional_usdt, fee_usdt, allocated_entry_fee_usdt,
        realized_gross_pnl_usdt, realized_net_pnl_usdt, filled_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      randomUUID(), intent.id, portfolio.id, positionRow, intent.symbol, receipt.action,
      receipt.quantity, receipt.fillPrice, receipt.notionalUsdt, receipt.feeUsdt,
      receipt.allocatedEntryFeeUsdt, receipt.realizedGrossPnlUsdt, receipt.realizedNetPnlUsdt,
      input.fillTime,
    ]);
    await client.query(`
      UPDATE strategy_follow_paper_portfolios
         SET cash_usdt=$2, realized_gross_pnl_usdt=$3, realized_net_pnl_usdt=$4, fees_usdt=$5, updated_at=now()
       WHERE id=$1
    `, [portfolio.id, next.cashUsdt, next.realizedGrossPnlUsdt, next.realizedNetPnlUsdt, next.feesUsdt]);
    await client.query(`
      UPDATE strategy_follow_paper_order_intents SET status='filled', filled_at=$2 WHERE id=$1
    `, [intent.id, input.fillTime]);
    await client.query("COMMIT");
    return { intentId: intent.id, status: "filled" as const, realizedNetPnlUsdt: receipt.realizedNetPnlUsdt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function upsertPosition(
  client: { query: Pool["query"] },
  portfolioId: string,
  symbol: string,
  next: OfficialPaperPortfolioState,
  at: Date,
): Promise<string | null> {
  const position = next.positions.find((entry) => entry.symbol === symbol);
  const existing = (await client.query<{ id: string }>(
    "SELECT id FROM strategy_follow_paper_positions WHERE portfolio_id=$1 AND symbol=$2 AND status='open'",
    [portfolioId, symbol],
  )).rows[0];

  if (!position) {
    // 平掉了：关闭而不是删除。删掉持仓等于抹掉这段历史，而周结算要按回执与持仓复核。
    if (existing) {
      await client.query(
        "UPDATE strategy_follow_paper_positions SET status='closed', quantity=quantity, closed_at=$2 WHERE id=$1",
        [existing.id, at],
      );
    }
    return existing?.id ?? null;
  }
  if (existing) {
    await client.query(`
      UPDATE strategy_follow_paper_positions
         SET quantity=$2, average_entry_price=$3, cost_basis_usdt=$4, entry_fees_usdt=$5
       WHERE id=$1
    `, [existing.id, position.quantity, position.averageEntryPrice, position.costBasisUsdt, position.entryFeesUsdt]);
    return existing.id;
  }
  const id = randomUUID();
  await client.query(`
    INSERT INTO strategy_follow_paper_positions (
      id, portfolio_id, symbol, status, quantity, average_entry_price, cost_basis_usdt, entry_fees_usdt, opened_at
    ) VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8)
  `, [id, portfolioId, symbol, position.quantity, position.averageEntryPrice, position.costBasisUsdt, position.entryFeesUsdt, at]);
  return id;
}

/**
 * 落库一个跟单运行周期，并在有订单意图时入队。
 *
 * 与官方卡的 `completeStrategyRuntimeCycle` 分开：那一条深度耦合官方组合与共享决策轮
 * （硬编码 10,000 本金、写 official_paper_order_intents、锁官方组合的访问状态），跟单这条
 * 都不适用。**引擎与记账共用，编排不共用**——把两套编排硬合成一个函数会让各自的前置条件
 * 互相渗透。
 *
 * 不写共享决策轮：ADR-0018 的共享轮只属于三张官方卡。
 *
 * 幂等按 (部署, K 线收盘时间) 判定——同一根 K 线重跑返回原周期且不重复入队，否则一次决策
 * 会记两笔成交。
 */
export async function completeFollowRuntimeCycle(database: Pool, input: {
  cycleId: string;
  deploymentId: string;
  portfolioId: string;
  fencingToken: number;
  candleOpenTime: Date;
  candleCloseTime: Date;
  decision: Record<string, unknown>;
  orderIntent: Record<string, unknown> | null;
  events: Array<{
    sequence: number; role: string; conclusion: string; evidence: Record<string, unknown>;
    durationMs: number; llmUsed: boolean;
  }>;
  traceId: string;
  startedAt: Date;
  nextCycleAt: Date;
  symbol: string;
  shadow: boolean;
  /** 单笔名义金额，由本金 × 客户同意的每单占比算出。 */
  quoteAmountUsdt: number;
  feeRate: number;
}) {
  if (input.events.length !== 7) throw new Error("每个运行周期必须保存七个 Agent 事件");
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const existing = (await client.query<{ id: string }>(
      "SELECT id FROM strategy_runtime_cycles WHERE deployment_id=$1 AND candle_close_time=$2",
      [input.deploymentId, input.candleCloseTime],
    )).rows[0];
    if (existing) {
      await client.query("COMMIT");
      return { id: existing.id, duplicate: true };
    }
    const sequence = (await client.query<{ last_cycle_sequence: number }>(`
      UPDATE strategy_deployments
         SET last_cycle_sequence = last_cycle_sequence + 1,
             last_candle_close_at = $2, next_cycle_at = $3, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1
      RETURNING last_cycle_sequence
    `, [input.deploymentId, input.candleCloseTime, input.nextCycleAt])).rows[0].last_cycle_sequence;

    await client.query(`
      INSERT INTO strategy_runtime_cycles (
        id, deployment_id, sequence, fencing_token, candle_open_time, candle_close_time,
        status, decision_json, order_intent_json, trace_id, started_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,$8::jsonb,$9,$10)
    `, [input.cycleId, input.deploymentId, sequence, input.fencingToken,
      input.candleOpenTime, input.candleCloseTime, JSON.stringify(input.decision),
      input.orderIntent ? JSON.stringify(input.orderIntent) : null, input.traceId, input.startedAt]);

    for (const event of input.events) {
      await client.query(`
        INSERT INTO strategy_runtime_events (
          id, cycle_id, sequence, role, event_type, conclusion, evidence_json, duration_ms, llm_used
        ) VALUES ($1,$2,$3,$4,'agent_completed',$5,$6::jsonb,$7,$8)
      `, [randomUUID(), input.cycleId, event.sequence, event.role, event.conclusion,
        JSON.stringify(event.evidence), event.durationMs, event.llmUsed]);
    }

    if (input.orderIntent) {
      const action = String(input.orderIntent.action);
      // 现货只能做多。空头意图到这里说明准入漏了，失败关闭而不是悄悄丢弃。
      if (action === "enter_short") throw new Error("现货跟单不得生成空头意图");
      if (action !== "enter_long" && action !== "exit") throw new Error("现货跟单订单动作无效");
      await client.query(`
        INSERT INTO strategy_follow_paper_order_intents (
          id, portfolio_id, deployment_id, runtime_cycle_id, idempotency_key,
          symbol, action, execution_timing, requested_price, status, payload_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [
        randomUUID(), input.portfolioId, input.deploymentId, input.cycleId,
        String(input.orderIntent.idempotencyKey), input.symbol,
        action === "enter_long" ? "buy" : "sell",
        String(input.orderIntent.executionTiming ?? "next_candle_open"),
        input.orderIntent.requestedPrice ?? null,
        input.shadow ? "shadowed" : "pending",
        JSON.stringify({ quoteAmountUsdt: input.quoteAmountUsdt, feeRate: input.feeRate }),
      ]);
    }
    await client.query("COMMIT");
    return { id: input.cycleId, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
