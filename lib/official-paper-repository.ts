import type { Pool, PoolClient } from "pg";

import { membershipAccess } from "./membership-rules.ts";
import {
  applyOfficialPaperFill,
  officialPaperPortfolioSeeds,
  type OfficialPaperPortfolioState,
} from "./official-paper-portfolio.ts";
import {
  officialTradingHallStrategies,
  type OfficialTradingHallStrategy,
} from "../packages/contracts/src/trading-hall.ts";

type Queryable = Pick<Pool | PoolClient, "query">;
type StrategyCode = OfficialTradingHallStrategy["code"];

export async function ensureOfficialPaperPortfolios(database: Queryable, input: {
  membershipId: string;
  customerId: string;
}) {
  const membership = await database.query<{ present: boolean }>(`
    SELECT true AS present
    FROM memberships
    WHERE id = $1 AND customer_id = $2
    FOR KEY SHARE
  `, [input.membershipId, input.customerId]);
  if (membership.rows[0]?.present !== true) throw new Error("会员与客户归属不匹配");
  const portfolios = [];
  for (const seed of officialPaperPortfolioSeeds(input)) {
    const result = await database.query<{
      id: string; membership_id: string; customer_id: string; strategy_code: StrategyCode;
      principal_usdt: string; cash_usdt: string; access_status: "active" | "close_only" | "read_only";
      risk_json: OfficialPaperPortfolioState["strategyCode"];
    }>(`
      WITH inserted AS (
        INSERT INTO official_paper_portfolios (
          id, membership_id, customer_id, strategy_code,
          principal_usdt, cash_usdt, risk_json
        ) VALUES ($1, $2, $3, $4, 10000, 10000, $5::jsonb)
        ON CONFLICT (membership_id, strategy_code) DO NOTHING
        RETURNING *
      ), initial_ledger AS (
        INSERT INTO official_paper_ledger_entries (
          id, portfolio_id, entry_type, amount_usdt, balance_after_usdt,
          trace_id, occurred_at
        )
        SELECT $6, id, 'initial_cash', 10000, 10000, $7, now() FROM inserted
      )
      SELECT id, membership_id, customer_id, strategy_code,
             principal_usdt, cash_usdt, access_status, risk_json
      FROM inserted
      UNION ALL
      SELECT id, membership_id, customer_id, strategy_code,
             principal_usdt, cash_usdt, access_status, risk_json
      FROM official_paper_portfolios
      WHERE membership_id = $2 AND customer_id = $3 AND strategy_code = $4
      LIMIT 1
    `, [
      seed.id, seed.membershipId, seed.customerId, seed.strategyCode,
      JSON.stringify(seed.risk), crypto.randomUUID(), `paper-provision:${seed.membershipId}:${seed.strategyCode}`,
    ]);
    const row = result.rows[0];
    if (!row || row.customer_id !== input.customerId || row.id !== seed.id) {
      throw new Error("官方模拟盘组合初始化冲突");
    }
    portfolios.push({
      id: row.id,
      membershipId: row.membership_id,
      customerId: row.customer_id,
      strategyCode: row.strategy_code,
      principalUsdt: Number(row.principal_usdt),
      cashUsdt: Number(row.cash_usdt),
      access: row.access_status,
    });
  }
  return portfolios;
}

/**
 * Resolves the only paper portfolios eligible for official three-card accounting.
 * Callers provide trusted customer/membership context, never request-selected strategy IDs.
 */
export async function resolveOfficialThreeCardPortfolioScope(database: Queryable, input: {
  membershipId: string;
  customerId: string;
}) {
  const membershipId = input.membershipId.trim();
  const customerId = input.customerId.trim();
  if (!membershipId || !customerId) throw new Error("会员或客户标识缺失");

  const result = await database.query<{ id: string; strategy_code: StrategyCode }>(`
    SELECT id, strategy_code
    FROM official_paper_portfolios
    WHERE membership_id = $1 AND customer_id = $2
  `, [membershipId, customerId]);
  const byStrategyCode = new Map(result.rows.map((row) => [row.strategy_code, row.id]));
  const strategies = officialTradingHallStrategies.map((definition) => ({
    strategyCode: definition.code,
    portfolioId: byStrategyCode.get(definition.code),
  }));
  const complete = result.rows.length === officialTradingHallStrategies.length
    && strategies.every(({ strategyCode, portfolioId }) => (
      portfolioId === `official-paper:${membershipId}:${strategyCode}`
    ));
  if (!complete) throw new Error("官方三卡组合不完整，不能进入绩效计费");

  const recognized = strategies.map(({ strategyCode, portfolioId }) => ({
    strategyCode,
    portfolioId: portfolioId!,
  }));
  return {
    customerId,
    membershipId,
    scopeKey: `official-three:${membershipId}`,
    strategies: recognized,
    portfolioIds: recognized.map((item) => item.portfolioId),
  };
}

function previousCompleteUtcWeek(asOf: Date) {
  if (!Number.isFinite(asOf.getTime())) throw new Error("绩效周结算时间无效");
  const currentDayStart = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const daysSinceMonday = (asOf.getUTCDay() + 6) % 7;
  const periodEnd = new Date(currentDayStart - daysSinceMonday * 86_400_000);
  const periodStart = new Date(periodEnd.getTime() - 7 * 86_400_000);
  return { periodStart, periodEnd };
}

export async function aggregateOfficialThreeCardPreviousUtcWeek(database: Queryable, input: {
  membershipId: string;
  customerId: string;
  asOf?: Date;
}) {
  const scope = await resolveOfficialThreeCardPortfolioScope(database, input);
  const { periodStart, periodEnd } = previousCompleteUtcWeek(input.asOf ?? new Date());
  const result = await database.query<{
    portfolio_id: string; strategy_code: StrategyCode; realized_gross_pnl_usdt: string;
    realized_net_pnl_usdt: string; fees_usdt: string;
  }>(`
    SELECT portfolio.id AS portfolio_id, portfolio.strategy_code,
           COALESCE(sum(receipt.realized_gross_pnl_usdt), 0)::text AS realized_gross_pnl_usdt,
           COALESCE(sum(receipt.realized_net_pnl_usdt), 0)::text AS realized_net_pnl_usdt,
           COALESCE(sum(receipt.fee_usdt), 0)::text AS fees_usdt
    FROM official_paper_portfolios AS portfolio
    LEFT JOIN official_paper_fill_receipts AS receipt
      ON receipt.portfolio_id = portfolio.id
     AND receipt.filled_at >= $2 AND receipt.filled_at < $3
    WHERE portfolio.id = ANY($1::text[])
    GROUP BY portfolio.id, portfolio.strategy_code
  `, [scope.portfolioIds, periodStart, periodEnd]);
  const byPortfolio = new Map(result.rows.map((row) => [row.portfolio_id, row]));
  const strategies = scope.strategies.map((strategy) => {
    const row = byPortfolio.get(strategy.portfolioId);
    if (!row || row.strategy_code !== strategy.strategyCode) throw new Error("官方三卡周结算范围不完整");
    return {
      ...strategy,
      realizedGrossPnlUsdt: Number(row.realized_gross_pnl_usdt),
      realizedNetPnlUsdt: Number(row.realized_net_pnl_usdt),
      feesUsdt: Number(row.fees_usdt),
    };
  });
  const sum = (key: "realizedGrossPnlUsdt" | "realizedNetPnlUsdt" | "feesUsdt") => (
    Number(strategies.reduce((total, row) => total + row[key], 0).toFixed(8))
  );
  return {
    customerId: scope.customerId,
    membershipId: scope.membershipId,
    scopeKey: scope.scopeKey,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    realizedGrossPnlUsdt: sum("realizedGrossPnlUsdt"),
    realizedNetPnlUsdt: sum("realizedNetPnlUsdt"),
    feesUsdt: sum("feesUsdt"),
    strategies,
  };
}

export async function refreshOfficialPaperRiskState(database: Queryable, input: {
  deploymentId: string;
  portfolioId: string;
  asOf: Date;
}) {
  if (!Number.isFinite(input.asOf.getTime())) throw new Error("官方模拟盘风控时间无效");
  const portfolio = (await database.query<{
    principal_usdt: string; cash_usdt: string; risk_json: Record<string, unknown>;
    position_value_usdt: string;
  }>(`
    SELECT portfolio.principal_usdt, portfolio.cash_usdt, portfolio.risk_json,
           COALESCE(sum(position.quantity * position.last_mark_price)
             FILTER (WHERE position.status = 'open'), 0)::text AS position_value_usdt
    FROM official_paper_portfolios AS portfolio
    LEFT JOIN official_paper_positions AS position ON position.portfolio_id = portfolio.id
    WHERE portfolio.id = $1
    GROUP BY portfolio.id
  `, [input.portfolioId])).rows[0];
  const deployment = (await database.query<{ risk_state_json: Record<string, unknown> }>(`
    SELECT risk_state_json FROM strategy_deployments
    WHERE id = $1 AND paper_portfolio_id = $2 AND execution_product = 'spot_usdt'
    FOR UPDATE
  `, [input.deploymentId, input.portfolioId])).rows[0];
  if (!portfolio || !deployment) throw new Error("官方模拟盘风控上下文不存在");

  const principal = Number(portfolio.principal_usdt);
  const equityUsdt = Number(portfolio.cash_usdt) + Number(portfolio.position_value_usdt);
  if (!Number.isFinite(principal) || principal <= 0 || !Number.isFinite(equityUsdt)) {
    throw new Error("官方模拟盘风控权益无效");
  }
  const previous = deployment.risk_state_json || {};
  const riskDayUtc = input.asOf.toISOString().slice(0, 10);
  const previousEquity = Number(previous.equityUsdt);
  const dailyBaselineEquityUsdt = previous.riskDayUtc === riskDayUtc
    ? Number(previous.dailyBaselineEquityUsdt || principal)
    : Number.isFinite(previousEquity) ? previousEquity : principal;
  const previousPeak = Number(previous.peakEquityUsdt || principal);
  const peakEquityUsdt = Math.max(previousPeak, equityUsdt);
  const drawdownPct = peakEquityUsdt > 0 ? Math.max(0, (peakEquityUsdt - equityUsdt) / peakEquityUsdt * 100) : 100;
  const previousMaximum = Number(previous.maxDrawdownPct || 0);
  const maxDrawdownPct = Math.max(previousMaximum, drawdownPct);
  const dailyLossPct = dailyBaselineEquityUsdt > 0
    ? Math.max(0, (dailyBaselineEquityUsdt - equityUsdt) / dailyBaselineEquityUsdt * 100)
    : 100;
  const dailyLimit = Number(portfolio.risk_json.dailyLossHaltPct);
  const drawdownLimit = Number(portfolio.risk_json.maxDrawdownPct);
  const halted = previous.halted === true
    || (Number.isFinite(dailyLimit) && dailyLossPct >= dailyLimit)
    || (Number.isFinite(drawdownLimit) && maxDrawdownPct >= drawdownLimit);
  const next = {
    ...previous,
    equityUsdt: Number(equityUsdt.toFixed(8)),
    peakEquityUsdt: Number(peakEquityUsdt.toFixed(8)),
    dailyBaselineEquityUsdt: Number(dailyBaselineEquityUsdt.toFixed(8)),
    riskDayUtc,
    drawdownPct: Number(drawdownPct.toFixed(8)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(8)),
    dailyLossPct: Number(dailyLossPct.toFixed(8)),
    halted,
    updatedAt: input.asOf.toISOString(),
  };
  await database.query(`
    UPDATE strategy_deployments SET risk_state_json = $2::jsonb, updated_at = now()
    WHERE id = $1
  `, [input.deploymentId, JSON.stringify(next)]);
  return next;
}

export async function syncOfficialPaperPortfolioAccess(database: Queryable, input: {
  portfolioId: string;
  access: "active" | "close_only" | "read_only";
}) {
  const result = await database.query(`
    UPDATE official_paper_portfolios
    SET access_status = $2, updated_at = now()
    WHERE id = $1 AND access_status IS DISTINCT FROM $2
  `, [input.portfolioId, input.access]);
  return { changed: result.rowCount === 1 };
}

export async function loadOfficialPaperOpenPosition(database: Queryable, portfolioId: string, symbol?: string) {
  const result = await database.query<{
    id: string; symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
    quantity: string; average_entry_price: string;
  }>(`
    SELECT id, symbol, quantity, average_entry_price
    FROM official_paper_positions
    WHERE portfolio_id = $1 AND status = 'open'
      AND ($2::text IS NULL OR symbol = $2)
    ORDER BY opened_at, id LIMIT 1
  `, [portfolioId, symbol ?? null]);
  const row = result.rows[0];
  return row ? {
    id: row.id,
    symbol: row.symbol,
    side: "long" as const,
    quantity: Number(row.quantity),
    entryPrice: Number(row.average_entry_price),
  } : null;
}

export async function officialPaperHasOpenPositions(database: Queryable, portfolioId: string) {
  const result = await database.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM official_paper_positions
      WHERE portfolio_id = $1 AND status = 'open'
    ) AS present
  `, [portfolioId]);
  return result.rows[0]?.present === true;
}

export async function markOfficialPaperPosition(database: Queryable, input: {
  portfolioId: string;
  symbol: string;
  markPrice: number;
  markedAt: Date;
}) {
  if (!Number.isFinite(input.markPrice) || input.markPrice <= 0) throw new Error("官方模拟盘标记价格无效");
  await database.query(`
    UPDATE official_paper_positions
    SET last_mark_price = $3,
        unrealized_pnl_usdt = quantity * $3 - cost_basis_usdt,
        updated_at = $4
    WHERE portfolio_id = $1 AND symbol = $2 AND status = 'open'
  `, [input.portfolioId, input.symbol, input.markPrice, input.markedAt]);
}

export async function settlePendingOfficialPaperOrder(database: Pool, input: {
  deploymentId: string;
  fillPrice?: number;
  fillTime: Date;
  timing: "next_candle_open" | "intrabar_threshold";
  traceId: string;
}) {
  if (input.fillPrice !== undefined && (!Number.isFinite(input.fillPrice) || input.fillPrice <= 0)) {
    throw new Error("官方模拟成交价格无效");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const intent = (await client.query<{
      id: string; portfolio_id: string; symbol: string; action: "buy" | "sell";
      requested_price: string | null; payload_json: Record<string, unknown>;
    }>(`
      SELECT id, portfolio_id, symbol, action, requested_price, payload_json
      FROM official_paper_order_intents
      WHERE deployment_id = $1 AND status = 'pending' AND execution_timing = $2
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED LIMIT 1
    `, [input.deploymentId, input.timing])).rows[0];
    if (!intent) {
      await client.query("COMMIT");
      return null;
    }
    const portfolio = (await client.query<{
      id: string; strategy_code: StrategyCode; access_status: OfficialPaperPortfolioState["access"];
      principal_usdt: string; cash_usdt: string; realized_pnl_usdt: string;
      realized_gross_pnl_usdt: string; realized_net_pnl_usdt: string; fees_usdt: string;
      membership_status: string; membership_expires_at: string | null; membership_grace_ends_at: string | null;
    }>(`
      SELECT portfolio.id, portfolio.strategy_code, portfolio.access_status,
             portfolio.principal_usdt, portfolio.cash_usdt,
             portfolio.realized_pnl_usdt, portfolio.realized_gross_pnl_usdt,
             portfolio.realized_net_pnl_usdt, portfolio.fees_usdt,
             membership.status AS membership_status,
             membership.expires_at AS membership_expires_at,
             membership.grace_ends_at AS membership_grace_ends_at
      FROM official_paper_portfolios AS portfolio
      JOIN memberships AS membership
        ON membership.id = portfolio.membership_id
       AND membership.customer_id = portfolio.customer_id
      WHERE portfolio.id = $1
      FOR UPDATE OF portfolio, membership
    `, [intent.portfolio_id])).rows[0];
    if (!portfolio) throw new Error("官方模拟盘组合不存在");
    const positions = await client.query<{
      id: string; symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT"; quantity: string;
      average_entry_price: string; cost_basis_usdt: string; entry_fees_usdt: string;
      realized_gross_pnl_usdt: string; realized_net_pnl_usdt: string;
    }>(`
      SELECT id, symbol, quantity, average_entry_price, cost_basis_usdt,
             entry_fees_usdt, realized_gross_pnl_usdt, realized_net_pnl_usdt
      FROM official_paper_positions
      WHERE portfolio_id = $1 AND status = 'open'
      ORDER BY opened_at, id FOR UPDATE
    `, [portfolio.id]);
    const currentMembershipAccess = membershipAccess(input.fillTime.toISOString(), {
      status: portfolio.membership_status,
      expiresAt: portfolio.membership_expires_at,
      graceEndsAt: portfolio.membership_grace_ends_at,
    });
    const settlementAccess = currentMembershipAccess.newEntriesAllowed
      ? "active" as const
      : positions.rows.length > 0 ? "close_only" as const : "read_only" as const;
    if (settlementAccess !== portfolio.access_status) {
      await client.query(`
        UPDATE official_paper_portfolios
        SET access_status = $2, updated_at = $3
        WHERE id = $1
      `, [portfolio.id, settlementAccess, input.fillTime]);
    }
    const fills = await client.query<{
      action: "buy" | "sell"; symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
      quantity: string; fill_price: string; notional_usdt: string; fee_usdt: string;
      allocated_entry_fee_usdt: string; realized_gross_pnl_usdt: string;
      realized_net_pnl_usdt: string; filled_at: Date;
    }>(`
      SELECT action, symbol, quantity, fill_price, notional_usdt, fee_usdt,
             allocated_entry_fee_usdt, realized_gross_pnl_usdt,
             realized_net_pnl_usdt, filled_at
      FROM official_paper_fill_receipts
      WHERE portfolio_id = $1 ORDER BY filled_at, id
    `, [portfolio.id]);
    const state: OfficialPaperPortfolioState = {
      strategyCode: portfolio.strategy_code,
      access: settlementAccess,
      principalUsdt: 10_000,
      cashUsdt: Number(portfolio.cash_usdt),
      equityUsdt: Number(portfolio.cash_usdt) + positions.rows.reduce((sum, row) => sum + Number(row.cost_basis_usdt), 0),
      realizedGrossPnlUsdt: Number(portfolio.realized_gross_pnl_usdt),
      realizedNetPnlUsdt: Number(portfolio.realized_net_pnl_usdt),
      realizedPnlUsdt: Number(portfolio.realized_net_pnl_usdt),
      unrealizedPnlUsdt: 0,
      feesUsdt: Number(portfolio.fees_usdt),
      positions: positions.rows.map((row) => ({
        symbol: row.symbol,
        side: "long",
        quantity: Number(row.quantity),
        averageEntryPrice: Number(row.average_entry_price),
        costBasisUsdt: Number(row.cost_basis_usdt),
        entryFeesUsdt: Number(row.entry_fees_usdt),
        marketPrice: Number(row.average_entry_price),
        marketValueUsdt: Number(row.cost_basis_usdt),
        unrealizedPnlUsdt: 0,
      })),
      fills: fills.rows.map((row) => ({
        action: row.action,
        symbol: row.symbol,
        quantity: Number(row.quantity),
        fillPrice: Number(row.fill_price),
        notionalUsdt: Number(row.notional_usdt),
        feeUsdt: Number(row.fee_usdt),
        allocatedEntryFeeUsdt: Number(row.allocated_entry_fee_usdt),
        realizedGrossPnlUsdt: Number(row.realized_gross_pnl_usdt),
        realizedNetPnlUsdt: Number(row.realized_net_pnl_usdt),
        filledAt: row.filled_at.toISOString(),
      })),
    };
    const fillPrice = input.fillPrice ?? Number(intent.requested_price);
    const feeRate = Number(intent.payload_json.takerFeeRate ?? 0.001);
    const quoteAmountUsdt = Number(intent.payload_json.quoteAmountUsdt);
    const openPosition = state.positions.find((position) => position.symbol === intent.symbol);
    let next: OfficialPaperPortfolioState;
    try {
      next = applyOfficialPaperFill(state, {
        action: intent.action,
        symbol: intent.symbol,
        fillPrice,
        quoteAmountUsdt,
        quantity: intent.action === "sell"
          ? Number(intent.payload_json.quantity ?? openPosition?.quantity)
          : undefined,
        feeRate,
        filledAt: input.fillTime.toISOString(),
      });
    } catch (error) {
      await client.query(`
        UPDATE official_paper_order_intents
        SET status = 'rejected', rejection_code = $2
        WHERE id = $1
      `, [intent.id, error instanceof Error ? error.message.slice(0, 120) : "PAPER_RISK_REJECTED"]);
      await client.query("COMMIT");
      return { status: "rejected" as const, reason: error instanceof Error ? error.message : "模拟盘风控拒绝" };
    }

    const nextPosition = next.positions.find((position) => position.symbol === intent.symbol);
    const priorPosition = positions.rows.find((position) => position.symbol === intent.symbol);
    const realizedGrossDelta = next.realizedGrossPnlUsdt - state.realizedGrossPnlUsdt;
    const realizedNetDelta = next.realizedNetPnlUsdt - state.realizedNetPnlUsdt;
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
        realizedNetDelta, realizedGrossDelta, input.fillTime]);
    } else if (nextPosition) {
      positionId = crypto.randomUUID();
      await client.query(`
        INSERT INTO official_paper_positions (
          id, portfolio_id, symbol, side, status, quantity,
          average_entry_price, cost_basis_usdt, entry_fees_usdt,
          last_mark_price, unrealized_pnl_usdt, opened_at
        ) VALUES ($1, $2, $3, 'long', 'open', $4, $5, $6, $7, $8, $9, $10)
      `, [positionId, portfolio.id, nextPosition.symbol, nextPosition.quantity, nextPosition.averageEntryPrice,
        nextPosition.costBasisUsdt, nextPosition.entryFeesUsdt, nextPosition.marketPrice,
        nextPosition.unrealizedPnlUsdt, input.fillTime]);
    } else if (priorPosition) {
      await client.query(`
        UPDATE official_paper_positions
        SET status = 'closed', entry_fees_usdt = 0,
            realized_pnl_usdt = realized_pnl_usdt + $2,
            realized_gross_pnl_usdt = realized_gross_pnl_usdt + $3,
            realized_net_pnl_usdt = realized_net_pnl_usdt + $2,
            closed_at = $4, updated_at = $4
        WHERE id = $1
      `, [priorPosition.id, realizedNetDelta, realizedGrossDelta, input.fillTime]);
    }

    const finalAccess = currentMembershipAccess.newEntriesAllowed
      ? "active"
      : next.positions.length > 0 ? "close_only" : "read_only";
    await client.query(`
      UPDATE official_paper_portfolios
      SET cash_usdt = $2, realized_pnl_usdt = $3,
          realized_gross_pnl_usdt = $4, realized_net_pnl_usdt = $3,
          fees_usdt = $5, access_status = $6, updated_at = $7
      WHERE id = $1
    `, [portfolio.id, next.cashUsdt, next.realizedNetPnlUsdt,
      next.realizedGrossPnlUsdt, next.feesUsdt, finalAccess, input.fillTime]);
    const latestFill = next.fills.at(-1)!;
    const receiptId = crypto.randomUUID();
    await client.query(`
      INSERT INTO official_paper_fill_receipts (
        id, intent_id, portfolio_id, position_id, symbol, action,
        quantity, fill_price, notional_usdt, fee_usdt, allocated_entry_fee_usdt,
        realized_pnl_usdt, realized_gross_pnl_usdt, realized_net_pnl_usdt,
        trace_id, filled_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `, [receiptId, intent.id, portfolio.id, positionId, latestFill.symbol, latestFill.action,
      latestFill.quantity, latestFill.fillPrice, latestFill.notionalUsdt, latestFill.feeUsdt,
      latestFill.allocatedEntryFeeUsdt, latestFill.realizedNetPnlUsdt,
      latestFill.realizedGrossPnlUsdt, latestFill.realizedNetPnlUsdt,
      input.traceId, input.fillTime]);
    const cashDelta = next.cashUsdt - state.cashUsdt;
    await client.query(`
      INSERT INTO official_paper_ledger_entries (
        id, portfolio_id, fill_receipt_id, entry_type, amount_usdt,
        balance_after_usdt, symbol, trace_id, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [crypto.randomUUID(), portfolio.id, receiptId, latestFill.action, cashDelta,
      next.cashUsdt, latestFill.symbol, input.traceId, input.fillTime]);
    await client.query(`
      UPDATE official_paper_order_intents SET status = 'filled', filled_at = $2 WHERE id = $1
    `, [intent.id, input.fillTime]);
    await refreshOfficialPaperRiskState(client, {
      deploymentId: input.deploymentId,
      portfolioId: portfolio.id,
      asOf: input.fillTime,
    });
    await client.query("COMMIT");
    return { status: "filled" as const, receiptId, portfolioId: portfolio.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listOfficialPaperPortfolios(database: Queryable, customerId: string) {
  const result = await database.query<{
    id: string; membership_id: string; strategy_code: StrategyCode; principal_usdt: string;
    cash_usdt: string; realized_pnl_usdt: string; realized_gross_pnl_usdt: string;
    realized_net_pnl_usdt: string; fees_usdt: string; access_status: string;
    updated_at: Date; position_count: number; position_value_usdt: string; unrealized_pnl_usdt: string;
  }>(`
    SELECT portfolio.id, portfolio.membership_id, portfolio.strategy_code,
           portfolio.principal_usdt, portfolio.cash_usdt, portfolio.realized_pnl_usdt,
           portfolio.realized_gross_pnl_usdt, portfolio.realized_net_pnl_usdt,
           portfolio.fees_usdt, portfolio.access_status, portfolio.updated_at,
           count(position.id)::int AS position_count,
           COALESCE(sum(position.quantity * position.last_mark_price), 0)::text AS position_value_usdt,
           COALESCE(sum(position.unrealized_pnl_usdt), 0)::text AS unrealized_pnl_usdt
    FROM official_paper_portfolios AS portfolio
    LEFT JOIN official_paper_positions AS position
      ON position.portfolio_id = portfolio.id AND position.status = 'open'
    WHERE portfolio.customer_id = $1
    GROUP BY portfolio.id
    ORDER BY portfolio.strategy_code
  `, [customerId]);
  const positions = await database.query<{
    id: string; portfolio_id: string; symbol: string; side: "long"; quantity: string;
    average_entry_price: string; cost_basis_usdt: string; entry_fees_usdt: string; last_mark_price: string;
    unrealized_pnl_usdt: string; opened_at: Date;
  }>(`
    SELECT position.id, position.portfolio_id, position.symbol, position.side,
           position.quantity, position.average_entry_price, position.cost_basis_usdt, position.entry_fees_usdt,
           position.last_mark_price, position.unrealized_pnl_usdt, position.opened_at
    FROM official_paper_positions AS position
    JOIN official_paper_portfolios AS portfolio ON portfolio.id = position.portfolio_id
    WHERE portfolio.customer_id = $1 AND position.status = 'open'
    ORDER BY position.opened_at, position.id
  `, [customerId]);
  return result.rows.map((row) => {
    const cash = Number(row.cash_usdt);
    const positionValue = Number(row.position_value_usdt);
    return {
      id: row.id,
      membershipId: row.membership_id,
      strategyCode: row.strategy_code,
      principalUsdt: Number(row.principal_usdt),
      cashUsdt: cash,
      equityUsdt: cash + positionValue,
      realizedPnlUsdt: Number(row.realized_net_pnl_usdt),
      realizedGrossPnlUsdt: Number(row.realized_gross_pnl_usdt),
      realizedNetPnlUsdt: Number(row.realized_net_pnl_usdt),
      unrealizedPnlUsdt: Number(row.unrealized_pnl_usdt),
      feesUsdt: Number(row.fees_usdt),
      access: row.access_status,
      openPositionCount: row.position_count,
      positions: positions.rows.filter((position) => position.portfolio_id === row.id).map((position) => ({
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        quantity: Number(position.quantity),
        averageEntryPrice: Number(position.average_entry_price),
        costBasisUsdt: Number(position.cost_basis_usdt),
        entryFeesUsdt: Number(position.entry_fees_usdt),
        lastMarkPrice: Number(position.last_mark_price),
        unrealizedPnlUsdt: Number(position.unrealized_pnl_usdt),
        openedAt: position.opened_at.toISOString(),
      })),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export async function listOfficialPaperTrades(database: Queryable, input: {
  customerId: string;
  cursor?: { filledAt: Date; id: string } | null;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const values: unknown[] = [input.customerId];
  let cursorSql = "";
  if (input.cursor) {
    values.push(input.cursor.filledAt, input.cursor.id);
    cursorSql = `AND (receipt.filled_at, receipt.id) < ($2, $3)`;
  }
  values.push(limit + 1);
  const result = await database.query<{
    id: string; portfolio_id: string; strategy_code: StrategyCode; symbol: string; action: string;
    quantity: string; fill_price: string; notional_usdt: string; fee_usdt: string;
    allocated_entry_fee_usdt: string; realized_pnl_usdt: string;
    realized_gross_pnl_usdt: string; realized_net_pnl_usdt: string;
    trace_id: string; filled_at: Date;
  }>(`
    SELECT receipt.id, receipt.portfolio_id, portfolio.strategy_code,
           receipt.symbol, receipt.action, receipt.quantity, receipt.fill_price,
           receipt.notional_usdt, receipt.fee_usdt, receipt.allocated_entry_fee_usdt,
           receipt.realized_pnl_usdt, receipt.realized_gross_pnl_usdt,
           receipt.realized_net_pnl_usdt,
           receipt.trace_id, receipt.filled_at
    FROM official_paper_fill_receipts AS receipt
    JOIN official_paper_portfolios AS portfolio ON portfolio.id = receipt.portfolio_id
    WHERE portfolio.customer_id = $1 ${cursorSql}
    ORDER BY receipt.filled_at DESC, receipt.id DESC
    LIMIT $${values.length}
  `, values);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map((row) => ({
      id: row.id,
      portfolioId: row.portfolio_id,
      strategyCode: row.strategy_code,
      symbol: row.symbol,
      action: row.action,
      quantity: Number(row.quantity),
      fillPrice: Number(row.fill_price),
      notionalUsdt: Number(row.notional_usdt),
      feeUsdt: Number(row.fee_usdt),
      allocatedEntryFeeUsdt: Number(row.allocated_entry_fee_usdt),
      realizedPnlUsdt: Number(row.realized_net_pnl_usdt),
      realizedGrossPnlUsdt: Number(row.realized_gross_pnl_usdt),
      realizedNetPnlUsdt: Number(row.realized_net_pnl_usdt),
      traceId: row.trace_id,
      filledAt: row.filled_at.toISOString(),
    })),
    nextCursor: hasMore && rows.length
      ? { filledAt: rows.at(-1)!.filled_at, id: rows.at(-1)!.id }
      : null,
  };
}
