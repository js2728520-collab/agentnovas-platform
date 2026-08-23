/**
 * 把实盘成交记进账本。
 *
 * 这一条路此前完全不存在，是 LIVE_EXECUTION_BLOCKERS 里前三条的共同根因：
 *
 *   LIVE_POSITION_TRACKING_MISSING   实盘成交不写任何仓位表，于是引擎只会不断
 *                                    产出开仓意图，永远不产出平仓意图——既无限
 *                                    加仓，客户又无法通过平台离场；
 *   LIVE_FILLS_NOT_IN_RISK_STATE     回撤与日亏取自组合净值，成交不进去就恒为 0，
 *                                    客户自己的风控预算在实盘上被静默旁路；
 *   LIVE_FILLS_NOT_IN_FEE_BASIS      绩效分成读同一批成交回执，零写入 = 零依据。
 *
 * 三条不是三个 bug，是同一个缺口的三种表现：**实盘成交没有进账本**。
 * 补上这一条路，三条同时消失——风控与分成都读账本，不读别的地方。
 *
 * 记的是「事实」而不是「回执」
 * 输入是 resolveEffectiveFill 的判定结果，不是下单响应。对账未决时不记账：
 * 把「不知道」记成任何一种确定状态都会亏真钱（见 effective-fill.ts）。
 */

import crypto from "node:crypto";
import type { Pool } from "pg";

import {
  applyOfficialPaperFill,
  type OfficialPaperPortfolioState,
} from "../packages/domain/src/official-paper-portfolio.ts";
import {
  isBookableFill,
  resolveEffectiveFill,
  type EffectiveFill,
  type ReceiptSnapshot,
  type ReconciliationSnapshot,
} from "../packages/domain/src/execution/effective-fill.ts";
import { refreshOfficialPaperRiskState } from "./official-paper-repository.ts";

export type LivePostingResult =
  | { status: "posted"; intentId: string; fillReceiptId: string; portfolioId: string }
  | { status: "skipped"; intentId: string; reason: string };

type ReceiptRow = {
  intent_id: string;
  deployment_id: string;
  symbol: string;
  side: "buy" | "sell";
  outcome: ReceiptSnapshot["outcome"];
  filled_quantity: string;
  average_price: string;
  fee_amount: string;
  rejection_reason: string | null;
  executed_at: Date;
  trace_id: string | null;
  portfolio_id: string;
  recon_status: ReconciliationSnapshot["status"] | null;
  recon_outcome: ReceiptSnapshot["outcome"] | null;
  recon_filled_quantity: string | null;
  recon_average_price: string | null;
  recon_fee_amount: string | null;
  recon_rejection_reason: string | null;
  recon_resolved_at: Date | null;
  recon_acknowledged_at: Date | null;
  runtime_cycle_id: string;
  decision_round_id: string;
};

function toEffective(row: ReceiptRow): EffectiveFill {
  const receipt: ReceiptSnapshot = {
    outcome: row.outcome,
    filledQuantity: Number(row.filled_quantity),
    averagePrice: Number(row.average_price),
    feeAmount: Number(row.fee_amount),
    rejectionReason: row.rejection_reason,
    executedAt: row.executed_at.toISOString(),
  };
  const reconciliation: ReconciliationSnapshot | null = row.recon_status === null ? null : {
    status: row.recon_status,
    resolvedOutcome: row.recon_outcome,
    filledQuantity: row.recon_filled_quantity === null ? null : Number(row.recon_filled_quantity),
    averagePrice: row.recon_average_price === null ? null : Number(row.recon_average_price),
    feeAmount: row.recon_fee_amount === null ? null : Number(row.recon_fee_amount),
    rejectionReason: row.recon_rejection_reason,
    resolvedAt: row.recon_resolved_at?.toISOString() ?? null,
    acknowledgedAt: row.recon_acknowledged_at?.toISOString() ?? null,
  };
  return resolveEffectiveFill(receipt, reconciliation);
}

/**
 * 把一个实盘部署已确定的成交记进账本，直到没有待记的为止。
 *
 * 幂等：已记过的意图由 live_book_postings 的唯一约束挡住。Worker 崩溃重启会重放
 * 同一轮决策（INV-8），重复记账会凭空复制客户的仓位。
 */
export async function postLiveFillsToBook(database: Pool, input: {
  deploymentId: string;
  limit?: number;
}): Promise<LivePostingResult[]> {
  const results: LivePostingResult[] = [];
  const limit = input.limit ?? 50;

  for (let index = 0; index < limit; index += 1) {
    const posted = await postNextLiveFill(database, input.deploymentId);
    if (!posted) break;
    results.push(posted);
  }
  return results;
}

async function postNextLiveFill(database: Pool, deploymentId: string): Promise<LivePostingResult | null> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");

    // 组合先上锁：同一个组合上的两笔成交必须串行记账，否则两边各自读到同一份
    // 起始状态，后写的那笔会把前一笔的现金与仓位覆盖掉。
    const portfolio = (await client.query<{
      id: string; strategy_code: OfficialPaperPortfolioState["strategyCode"];
      access_status: OfficialPaperPortfolioState["access"];
      principal_usdt: string; cash_usdt: string;
      realized_gross_pnl_usdt: string; realized_net_pnl_usdt: string; fees_usdt: string;
    }>(`
      SELECT portfolio.id, portfolio.strategy_code, portfolio.access_status,
             portfolio.principal_usdt, portfolio.cash_usdt,
             portfolio.realized_gross_pnl_usdt, portfolio.realized_net_pnl_usdt, portfolio.fees_usdt
      FROM official_paper_portfolios AS portfolio
      JOIN strategy_deployments AS deployment ON deployment.paper_portfolio_id = portfolio.id
      WHERE deployment.id = $1 AND deployment.mode = 'live' AND portfolio.book = 'live'
      FOR UPDATE OF portfolio
    `, [deploymentId])).rows[0];
    if (!portfolio) {
      await client.query("COMMIT");
      return null;
    }

    const row = (await client.query<ReceiptRow>(`
      SELECT receipt.intent_id, receipt.deployment_id, receipt.symbol, receipt.side,
             receipt.outcome, receipt.filled_quantity, receipt.average_price,
             receipt.fee_amount, receipt.rejection_reason, receipt.executed_at, receipt.trace_id,
             receipt.runtime_cycle_id, receipt.decision_round_id,
             $2::text AS portfolio_id,
             recon.status AS recon_status, recon.resolved_outcome AS recon_outcome,
             recon.filled_quantity AS recon_filled_quantity, recon.average_price AS recon_average_price,
             recon.fee_amount AS recon_fee_amount, recon.rejection_reason AS recon_rejection_reason,
             recon.resolved_at AS recon_resolved_at, recon.acknowledged_at AS recon_acknowledged_at
      FROM live_execution_receipts AS receipt
      LEFT JOIN execution_reconciliations AS recon ON recon.intent_id = receipt.intent_id
      WHERE receipt.deployment_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM live_book_postings AS posted WHERE posted.intent_id = receipt.intent_id
        )
      ORDER BY receipt.executed_at, receipt.id
      LIMIT 1
    `, [deploymentId, portfolio.id])).rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }

    const effective = toEffective(row);

    // 未决的成交**不跳过**，就停在这里。
    //
    // 跳过它去记后面那笔，会让账本按错误的顺序累计：一笔未决的买入后面跟着一笔卖出，
    // 先记卖出等于卖掉一个账上还不存在的仓位。成交必须按时间顺序逐笔落账。
    if (effective.state === "unsettled") {
      await client.query("COMMIT");
      return null;
    }

    if (!isBookableFill(effective)) {
      // 拒绝/过期/零成交：确定没有成交，登记一条「已处理」让它不再被取出。
      await recordPosting(client, row.intent_id, portfolio.id, null, effective, deploymentId);
      await client.query("COMMIT");
      return { status: "skipped", intentId: row.intent_id, reason: `NOT_BOOKABLE:${effective.outcome}` };
    }

    const positions = await client.query<{
      id: string; symbol: string; quantity: string; average_entry_price: string;
      cost_basis_usdt: string; entry_fees_usdt: string; last_mark_price: string;
    }>(`
      SELECT id, symbol, quantity, average_entry_price, cost_basis_usdt, entry_fees_usdt, last_mark_price
      FROM official_paper_positions
      WHERE portfolio_id = $1 AND status = 'open'
      ORDER BY opened_at, id FOR UPDATE
    `, [portfolio.id]);

    const state: OfficialPaperPortfolioState = {
      strategyCode: portfolio.strategy_code,
      access: portfolio.access_status,
      principalUsdt: Number(portfolio.principal_usdt),
      cashUsdt: Number(portfolio.cash_usdt),
      equityUsdt: Number(portfolio.cash_usdt)
        + positions.rows.reduce((sum, item) => sum + Number(item.cost_basis_usdt), 0),
      realizedGrossPnlUsdt: Number(portfolio.realized_gross_pnl_usdt),
      realizedNetPnlUsdt: Number(portfolio.realized_net_pnl_usdt),
      realizedPnlUsdt: Number(portfolio.realized_net_pnl_usdt),
      unrealizedPnlUsdt: 0,
      feesUsdt: Number(portfolio.fees_usdt),
      positions: positions.rows.map((item) => ({
        symbol: item.symbol as OfficialPaperPortfolioState["positions"][number]["symbol"],
        side: "long" as const,
        quantity: Number(item.quantity),
        averageEntryPrice: Number(item.average_entry_price),
        costBasisUsdt: Number(item.cost_basis_usdt),
        entryFeesUsdt: Number(item.entry_fees_usdt),
        marketPrice: Number(item.last_mark_price),
        marketValueUsdt: Number(item.cost_basis_usdt),
        unrealizedPnlUsdt: 0,
      })),
      fills: [],
    };

    // 数量与金额都取自交易所回报的事实，不重算。
    // 买入按 quantity * price 反推名义金额：域层的买入分支按报价金额记账，
    // 而交易所给的是成交量与均价。
    const notionalUsdt = effective.filledQuantity * effective.averagePrice;
    const next = applyOfficialPaperFill(state, {
      action: row.side,
      symbol: row.symbol,
      fillPrice: effective.averagePrice,
      quoteAmountUsdt: row.side === "buy" ? notionalUsdt : undefined,
      quantity: row.side === "sell" ? effective.filledQuantity : undefined,
      // 交易所回报的是金额，就按金额记——反推费率再乘回去会在小数位上漂，
      // 而漂掉的正是客户实际付出的成本。
      feeUsdt: effective.feeAmount,
      filledAt: effective.settledAt,
    });

    // 账本上的每一笔成交都要能回指一轮决策：先落意图，再落成交回执。
    // 模拟盘走的是同一条结构（意图 → 成交回执 → 账本分录），实盘不另开一套。
    await client.query(`
      INSERT INTO official_paper_order_intents (
        id, portfolio_id, deployment_id, runtime_cycle_id, idempotency_key,
        symbol, action, execution_timing, requested_price, status, payload_json, filled_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'live_market',$8,'filled',$9::jsonb,$10)
      ON CONFLICT (id) DO NOTHING
    `, [row.intent_id, portfolio.id, deploymentId, row.runtime_cycle_id,
      `live:${row.intent_id}`, row.symbol, row.side, effective.averagePrice,
      JSON.stringify({
        source: effective.source,
        decisionRoundId: row.decision_round_id,
        filledQuantity: effective.filledQuantity,
        feeUsdt: effective.feeAmount,
      }), effective.settledAt]);

    const fillReceiptId = await persistFill(client, {
      portfolioId: portfolio.id,
      intentId: row.intent_id,
      priorState: state,
      nextState: next,
      symbol: row.symbol,
      side: row.side,
      settledAt: new Date(effective.settledAt),
      traceId: row.trace_id ?? `live-post:${row.intent_id}`,
      priorPositions: positions.rows,
    });

    await recordPosting(client, row.intent_id, portfolio.id, fillReceiptId, effective, deploymentId);

    await refreshOfficialPaperRiskState(client, {
      deploymentId,
      portfolioId: portfolio.id,
      asOf: new Date(effective.settledAt),
    });

    await client.query("COMMIT");
    return { status: "posted", intentId: row.intent_id, fillReceiptId, portfolioId: portfolio.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordPosting(
  client: { query: Pool["query"] },
  intentId: string,
  portfolioId: string,
  fillReceiptId: string | null,
  effective: Extract<EffectiveFill, { state: "settled" }>,
  deploymentId: string,
): Promise<void> {
  await client.query(`
    INSERT INTO live_book_postings (
      id, intent_id, deployment_id, portfolio_id, fill_receipt_id,
      fact_source, outcome, contradicts_receipt, settled_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [crypto.randomUUID(), intentId, deploymentId, portfolioId, fillReceiptId,
    effective.source, effective.outcome, effective.contradictsReceipt, effective.settledAt]);
}

async function persistFill(
  client: { query: Pool["query"] },
  input: {
    portfolioId: string;
    intentId: string;
    priorState: OfficialPaperPortfolioState;
    nextState: OfficialPaperPortfolioState;
    symbol: string;
    side: "buy" | "sell";
    settledAt: Date;
    traceId: string;
    priorPositions: { id: string; symbol: string }[];
  },
): Promise<string> {
  const { portfolioId, priorState, nextState, symbol, settledAt, traceId } = input;
  const nextPosition = nextState.positions.find((item) => item.symbol === symbol);
  const priorPosition = input.priorPositions.find((item) => item.symbol === symbol);
  const realizedGrossDelta = nextState.realizedGrossPnlUsdt - priorState.realizedGrossPnlUsdt;
  const realizedNetDelta = nextState.realizedNetPnlUsdt - priorState.realizedNetPnlUsdt;
  let positionId: string | null = priorPosition?.id ?? null;

  if (nextPosition && priorPosition) {
    await client.query(`
      UPDATE official_paper_positions
      SET quantity = $2, average_entry_price = $3, cost_basis_usdt = $4,
          entry_fees_usdt = $5, last_mark_price = $6, unrealized_pnl_usdt = $7,
          realized_pnl_usdt = realized_pnl_usdt + $8,
          realized_gross_pnl_usdt = realized_gross_pnl_usdt + $9,
          realized_net_pnl_usdt = realized_net_pnl_usdt + $8,
          updated_at = $10
      WHERE id = $1
    `, [priorPosition.id, nextPosition.quantity, nextPosition.averageEntryPrice, nextPosition.costBasisUsdt,
      nextPosition.entryFeesUsdt, nextPosition.marketPrice, nextPosition.unrealizedPnlUsdt,
      realizedNetDelta, realizedGrossDelta, settledAt]);
  } else if (nextPosition) {
    positionId = crypto.randomUUID();
    await client.query(`
      INSERT INTO official_paper_positions (
        id, portfolio_id, symbol, side, status, quantity,
        average_entry_price, cost_basis_usdt, entry_fees_usdt,
        last_mark_price, unrealized_pnl_usdt, opened_at
      ) VALUES ($1,$2,$3,'long','open',$4,$5,$6,$7,$8,$9,$10)
    `, [positionId, portfolioId, nextPosition.symbol, nextPosition.quantity, nextPosition.averageEntryPrice,
      nextPosition.costBasisUsdt, nextPosition.entryFeesUsdt, nextPosition.marketPrice,
      nextPosition.unrealizedPnlUsdt, settledAt]);
  } else if (priorPosition) {
    await client.query(`
      UPDATE official_paper_positions
      SET status = 'closed', entry_fees_usdt = 0,
          realized_pnl_usdt = realized_pnl_usdt + $2,
          realized_gross_pnl_usdt = realized_gross_pnl_usdt + $3,
          realized_net_pnl_usdt = realized_net_pnl_usdt + $2,
          closed_at = $4, updated_at = $4
      WHERE id = $1
    `, [priorPosition.id, realizedNetDelta, realizedGrossDelta, settledAt]);
  }

  await client.query(`
    UPDATE official_paper_portfolios
    SET cash_usdt = $2, realized_pnl_usdt = $3, realized_gross_pnl_usdt = $4,
        realized_net_pnl_usdt = $3, fees_usdt = $5, updated_at = $6
    WHERE id = $1
  `, [portfolioId, nextState.cashUsdt, nextState.realizedNetPnlUsdt,
    nextState.realizedGrossPnlUsdt, nextState.feesUsdt, settledAt]);

  const latestFill = nextState.fills.at(-1)!;
  const fillReceiptId = crypto.randomUUID();
  // intent_id 走实盘意图标识：这张表的 UNIQUE (intent_id) 因此成为第二道防重复记账，
  // 与 live_book_postings 的唯一约束互相独立。
  await client.query(`
    INSERT INTO official_paper_fill_receipts (
      id, intent_id, portfolio_id, position_id, symbol, action,
      quantity, fill_price, notional_usdt, fee_usdt, allocated_entry_fee_usdt,
      realized_pnl_usdt, realized_gross_pnl_usdt, realized_net_pnl_usdt,
      trace_id, filled_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  `, [fillReceiptId, input.intentId, portfolioId, positionId, latestFill.symbol, latestFill.action,
    latestFill.quantity, latestFill.fillPrice, latestFill.notionalUsdt, latestFill.feeUsdt,
    latestFill.allocatedEntryFeeUsdt, latestFill.realizedNetPnlUsdt,
    latestFill.realizedGrossPnlUsdt, latestFill.realizedNetPnlUsdt, traceId, settledAt]);

  await client.query(`
    INSERT INTO official_paper_ledger_entries (
      id, portfolio_id, fill_receipt_id, entry_type, amount_usdt,
      balance_after_usdt, symbol, trace_id, occurred_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [crypto.randomUUID(), portfolioId, fillReceiptId, latestFill.action,
    nextState.cashUsdt - priorState.cashUsdt, nextState.cashUsdt, latestFill.symbol, traceId, settledAt]);

  return fillReceiptId;
}
