import type { Pool, PoolClient } from "pg";

import { membershipAccess } from "./membership-rules.ts";
import {
  applyOfficialPaperFill,
  officialPaperPortfolioSeeds,
  type OfficialPaperPortfolioState,
} from "../packages/domain/src/official-paper-portfolio.ts";
import {
  officialTradingHallStrategies,
  type OfficialTradingHallStrategy,
} from "../packages/contracts/src/trading-hall.ts";

type Queryable = Pick<Pool | PoolClient, "query">;
type StrategyCode = OfficialTradingHallStrategy["code"];
type OfficialPaperAccess = OfficialPaperPortfolioState["access"];

export const OFFICIAL_PAPER_EMERGENCY_REJECTION_CODE = "TRADING_EMERGENCY_STOPPED";

async function isOfficialPaperCustomerEmergencyStopped(database: Queryable, customerId: string) {
  const result = await database.query<{ stopped: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM trading_emergency_stops AS emergency
      WHERE emergency.active = true
        AND (
          emergency.scope_key = 'platform'
          OR EXISTS (
            SELECT 1 FROM users AS customer
            WHERE customer.id = $1
              AND customer.organization_id IS NOT NULL
              AND emergency.scope_key = 'organization:' || customer.organization_id
          )
          OR EXISTS (
            SELECT 1 FROM customer_attributions AS attribution
            WHERE attribution.customer_id = $1
              AND attribution.status = 'active'
              AND attribution.branch_id IS NOT NULL
              AND emergency.scope_key = 'organization:' || attribution.branch_id
          )
        )
    ) AS stopped
  `, [customerId]);
  return result.rows[0]?.stopped === true;
}

function constrainedOfficialPaperAccess(input: {
  storedAccess: OfficialPaperAccess;
  membershipAllowsNewEntries: boolean;
  emergencyStopped: boolean;
  hasOpenPositions: boolean;
}): OfficialPaperAccess {
  if (
    input.membershipAllowsNewEntries
    && !input.emergencyStopped
    && input.storedAccess === "active"
  ) return "active";
  return input.hasOpenPositions ? "close_only" : "read_only";
}

async function lockOfficialPaperCustomerAccess(database: Queryable, customerIds: string[]) {
  if (customerIds.length === 0) return;
  await database.query(`
    SELECT pg_advisory_xact_lock(hashtextextended('official-paper-access:' || customer_id, 0))
    FROM unnest($1::text[]) AS scoped_customer(customer_id)
    ORDER BY customer_id
  `, [[...new Set(customerIds)].sort()]);
}

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
        -- 0060 把唯一约束换成了 (membership_id, strategy_code, book)：同一张卡上
        -- 模拟盘与实盘各一本账。冲突目标必须跟着换，否则这条语句会直接报
        -- 「没有匹配的唯一约束」——建组合失败 = 客户开通会员后进不去交易大厅。
        ON CONFLICT (membership_id, strategy_code, book) DO NOTHING
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
/**
 * 计费范围必须按账本区分。
 *
 * 这个函数原来查「这个会员名下的全部组合」，然后断言恰好三个、且 id 都是
 * `official-paper:<membership>:<card>`。加进实盘组合之后，行数会变成四个，
 * 断言失败，这个客户的绩效计费会**整个停掉**——而错误信息是「官方三卡组合不完整」。
 *
 * 顺带一件更重要的事：模拟盘的盈亏不该和实盘盈亏混进同一张账单。前者客户从未拿到手，
 * 对它收绩效分成没有任何立场。按 book 分开是这条边界的落点。
 */
export async function resolveOfficialThreeCardPortfolioScope(database: Queryable, input: {
  membershipId: string;
  customerId: string;
  /** 默认 paper：保持现有计费行为不变。实盘计费必须显式传 'live'。 */
  book?: "paper" | "live";
}) {
  const membershipId = input.membershipId.trim();
  const customerId = input.customerId.trim();
  const book = input.book ?? "paper";
  if (!membershipId || !customerId) throw new Error("会员或客户标识缺失");

  const result = await database.query<{ id: string; strategy_code: StrategyCode }>(`
    SELECT id, strategy_code
    FROM official_paper_portfolios
    WHERE membership_id = $1 AND customer_id = $2 AND book = $3
  `, [membershipId, customerId, book]);
  const byStrategyCode = new Map(result.rows.map((row) => [row.strategy_code, row.id]));
  const strategies = officialTradingHallStrategies.map((definition) => ({
    strategyCode: definition.code,
    portfolioId: byStrategyCode.get(definition.code),
  }));
  // 模拟盘的三张卡是开通会员时一次性建齐的，缺一张就是数据出了问题，
  // 此时按不完整的视图计费会漏掉某张卡的亏损——只算盈利的那部分等于多收。
  if (book === "paper") {
    const complete = result.rows.length === officialTradingHallStrategies.length
      && strategies.every(({ strategyCode, portfolioId }) => (
        portfolioId === `official-paper:${membershipId}:${strategyCode}`
      ));
    if (!complete) throw new Error("官方三卡组合不完整，不能进入绩效计费");
  }

  // 实盘不要求三张卡齐全：客户按自己的节奏逐张上实盘，只有一张也要能正常计费。
  const recognized = strategies
    .filter(({ portfolioId }) => portfolioId !== undefined)
    .map(({ strategyCode, portfolioId }) => ({ strategyCode, portfolioId: portfolioId! }));
  if (recognized.length === 0) throw new Error("该账本下没有可计费的组合");

  return {
    customerId,
    membershipId,
    book,
    scopeKey: book === "paper" ? `official-three:${membershipId}` : `official-live:${membershipId}`,
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
  book?: "paper" | "live";
}) {
  const scope = await resolveOfficialThreeCardPortfolioScope(database, input);
  const { periodStart, periodEnd } = previousCompleteUtcWeek(input.asOf ?? new Date());
  const result = await database.query<{
    portfolio_id: string; strategy_code: StrategyCode;
    week_gross_pnl: string; week_net_pnl: string; week_fees: string;
    cumulative_net_pnl: string; prior_net_pnl: string;
    total_week_gross_pnl: string; total_week_net_pnl: string; total_week_fees: string;
    total_cumulative_net_pnl: string; total_prior_net_pnl: string;
  }>(`
    WITH metrics AS (
      SELECT portfolio.id AS portfolio_id, portfolio.strategy_code,
             COALESCE(sum(receipt.realized_gross_pnl_usdt)
               FILTER (WHERE receipt.filled_at >= $2 AND receipt.filled_at < $3), 0) AS week_gross_pnl,
             COALESCE(sum(receipt.realized_net_pnl_usdt)
               FILTER (WHERE receipt.filled_at >= $2 AND receipt.filled_at < $3), 0) AS week_net_pnl,
             COALESCE(sum(receipt.fee_usdt + receipt.allocated_entry_fee_usdt)
               FILTER (WHERE receipt.filled_at >= $2 AND receipt.filled_at < $3), 0) AS week_fees,
             COALESCE(sum(receipt.realized_net_pnl_usdt)
               FILTER (WHERE receipt.filled_at < $3), 0) AS cumulative_net_pnl,
             COALESCE(sum(receipt.realized_net_pnl_usdt)
               FILTER (WHERE receipt.filled_at < $2), 0) AS prior_net_pnl
      FROM official_paper_portfolios AS portfolio
      LEFT JOIN official_paper_fill_receipts AS receipt
        ON receipt.portfolio_id = portfolio.id AND receipt.action = 'sell'
      WHERE portfolio.id = ANY($1::text[])
      GROUP BY portfolio.id, portfolio.strategy_code
    )
    SELECT portfolio_id, strategy_code,
           to_char(week_gross_pnl, 'FM999999999999999999990.000000000000') AS week_gross_pnl,
           to_char(week_net_pnl, 'FM999999999999999999990.000000000000') AS week_net_pnl,
           to_char(week_fees, 'FM999999999999999999990.000000000000') AS week_fees,
           to_char(cumulative_net_pnl, 'FM999999999999999999990.000000000000') AS cumulative_net_pnl,
           to_char(prior_net_pnl, 'FM999999999999999999990.000000000000') AS prior_net_pnl,
           to_char(sum(week_gross_pnl) OVER (), 'FM999999999999999999990.000000000000') AS total_week_gross_pnl,
           to_char(sum(week_net_pnl) OVER (), 'FM999999999999999999990.000000000000') AS total_week_net_pnl,
           to_char(sum(week_fees) OVER (), 'FM999999999999999999990.000000000000') AS total_week_fees,
           to_char(sum(cumulative_net_pnl) OVER (), 'FM999999999999999999990.000000000000') AS total_cumulative_net_pnl,
           to_char(sum(prior_net_pnl) OVER (), 'FM999999999999999999990.000000000000') AS total_prior_net_pnl
    FROM metrics
  `, [scope.portfolioIds, periodStart, periodEnd]);
  const byPortfolio = new Map(result.rows.map((row) => [row.portfolio_id, row]));
  const strategies = scope.strategies.map((strategy) => {
    const row = byPortfolio.get(strategy.portfolioId);
    if (!row || row.strategy_code !== strategy.strategyCode) throw new Error("官方三卡周结算范围不完整");
    return {
      ...strategy,
      realizedGrossPnlUsdt: row.week_gross_pnl,
      realizedNetPnlUsdt: row.week_net_pnl,
      feesUsdt: row.week_fees,
      cumulativeNetPnl: row.cumulative_net_pnl,
      priorNetPnl: row.prior_net_pnl,
    };
  });
  const totals = result.rows[0];
  if (!totals) throw new Error("官方三卡周结算范围不完整");
  return {
    customerId: scope.customerId,
    membershipId: scope.membershipId,
    scopeKey: scope.scopeKey,
    scopeVersion: "official-paper-closed-sells-v1" as const,
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    weekNetPnl: totals.total_week_net_pnl,
    cumulativeNetPnl: totals.total_cumulative_net_pnl,
    priorNetPnl: totals.total_prior_net_pnl,
    realizedGrossPnlUsdt: totals.total_week_gross_pnl,
    realizedNetPnlUsdt: totals.total_week_net_pnl,
    feesUsdt: totals.total_week_fees,
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
  const sameRiskDay = previous.riskDayUtc === riskDayUtc;
  const explicitPreviousReasons = Array.isArray(previous.haltReasons)
    ? previous.haltReasons.filter((value): value is string => typeof value === "string")
    : [];
  const inferredPreviousReasons = explicitPreviousReasons.length || previous.halted !== true
    ? explicitPreviousReasons
    : Number(previous.dailyLossPct) >= dailyLimit
      ? ["daily_loss"]
      : Number(previous.maxDrawdownPct) >= drawdownLimit
        ? ["max_drawdown"]
        : ["legacy_manual"];
  const haltReasons = new Set(inferredPreviousReasons.filter((reason) => sameRiskDay || reason !== "daily_loss"));
  if (Number.isFinite(dailyLimit) && dailyLossPct >= dailyLimit) haltReasons.add("daily_loss");
  if (Number.isFinite(drawdownLimit) && maxDrawdownPct >= drawdownLimit) haltReasons.add("max_drawdown");
  const nextHaltReasons = [...haltReasons].sort();
  const halted = nextHaltReasons.length > 0;
  const next = {
    ...previous,
    equityUsdt: Number(equityUsdt.toFixed(8)),
    peakEquityUsdt: Number(peakEquityUsdt.toFixed(8)),
    dailyBaselineEquityUsdt: Number(dailyBaselineEquityUsdt.toFixed(8)),
    riskDayUtc,
    drawdownPct: Number(drawdownPct.toFixed(8)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(8)),
    dailyLossPct: Number(dailyLossPct.toFixed(8)),
    haltReasons: nextHaltReasons,
    halted,
    updatedAt: input.asOf.toISOString(),
  };
  await database.query(`
    UPDATE strategy_deployments SET risk_state_json = $2::jsonb, updated_at = now()
    WHERE id = $1
  `, [input.deploymentId, JSON.stringify(next)]);
  return next;
}

async function resolveOfficialPaperAccess(database: Queryable, input: {
  portfolioId: string;
  asOf: Date;
  lock: boolean;
}) {
  const portfolio = (await database.query<{
    customer_id: string;
    access_status: OfficialPaperAccess;
    membership_status: string;
    membership_expires_at: string | null;
    membership_grace_ends_at: string | null;
    has_open_positions: boolean;
  }>(`
    SELECT portfolio.customer_id, portfolio.access_status,
           membership.status AS membership_status,
           membership.expires_at AS membership_expires_at,
           membership.grace_ends_at AS membership_grace_ends_at,
           EXISTS (
             SELECT 1 FROM official_paper_positions AS position
             WHERE position.portfolio_id = portfolio.id AND position.status = 'open'
           ) AS has_open_positions
    FROM official_paper_portfolios AS portfolio
    JOIN memberships AS membership
      ON membership.id = portfolio.membership_id
     AND membership.customer_id = portfolio.customer_id
    WHERE portfolio.id = $1
    ${input.lock ? "FOR UPDATE OF portfolio, membership" : ""}
  `, [input.portfolioId])).rows[0];
  if (!portfolio) throw new Error("官方模拟盘组合不存在");
  const membership = membershipAccess(input.asOf.toISOString(), {
    status: portfolio.membership_status,
    expiresAt: portfolio.membership_expires_at,
    graceEndsAt: portfolio.membership_grace_ends_at,
  });
  const emergencyStopped = await isOfficialPaperCustomerEmergencyStopped(database, portfolio.customer_id);
  return {
    access: constrainedOfficialPaperAccess({
      storedAccess: portfolio.access_status,
      membershipAllowsNewEntries: membership.newEntriesAllowed,
      emergencyStopped,
      hasOpenPositions: portfolio.has_open_positions,
    }),
    emergencyStopped,
    membershipAllowsNewEntries: membership.newEntriesAllowed,
    hasOpenPositions: portfolio.has_open_positions,
  };
}

export async function resolveOfficialPaperRuntimeAccess(database: Queryable, input: {
  portfolioId: string;
  asOf: Date;
}) {
  return resolveOfficialPaperAccess(database, { ...input, lock: false });
}

export async function lockOfficialPaperRuntimeAccess(database: Queryable, input: {
  portfolioId: string;
  asOf: Date;
}) {
  return resolveOfficialPaperAccess(database, { ...input, lock: true });
}

export async function restrictOfficialPaperPortfoliosForEmergency(database: Queryable, input: {
  customerIds: string[];
  now: Date;
}) {
  if (input.customerIds.length === 0) {
    return { changedPortfolios: [] as Array<{ accessStatus: "close_only" | "read_only" }>, rejectedPendingBuys: 0 };
  }
  await lockOfficialPaperCustomerAccess(database, input.customerIds);
  const changedPortfolios = (await database.query<{ accessStatus: "close_only" | "read_only" }>(`
    UPDATE official_paper_portfolios AS portfolio
    SET access_status = CASE WHEN EXISTS (
          SELECT 1 FROM official_paper_positions AS position
          WHERE position.portfolio_id = portfolio.id
            AND position.status = 'open'
            AND position.quantity > 0
        ) THEN 'close_only' ELSE 'read_only' END,
        updated_at = $2
    WHERE portfolio.customer_id = ANY($1::text[])
      AND portfolio.access_status IS DISTINCT FROM CASE WHEN EXISTS (
        SELECT 1 FROM official_paper_positions AS position
        WHERE position.portfolio_id = portfolio.id
          AND position.status = 'open'
          AND position.quantity > 0
      ) THEN 'close_only' ELSE 'read_only' END
    RETURNING access_status AS "accessStatus"
  `, [input.customerIds, input.now])).rows;
  const rejectedPendingBuys = await database.query(`
    UPDATE official_paper_order_intents AS intent
    SET status = 'rejected', rejection_code = $2
    FROM official_paper_portfolios AS portfolio
    WHERE intent.portfolio_id = portfolio.id
      AND portfolio.customer_id = ANY($1::text[])
      AND intent.action = 'buy'
      AND intent.status = 'pending'
  `, [input.customerIds, OFFICIAL_PAPER_EMERGENCY_REJECTION_CODE]);
  return { changedPortfolios, rejectedPendingBuys: rejectedPendingBuys.rowCount ?? 0 };
}

export async function activateOfficialPaperPortfoliosAfterDisclosure(database: Queryable, input: {
  membershipId: string;
  customerId: string;
  now: Date;
}) {
  await lockOfficialPaperCustomerAccess(database, [input.customerId]);
  if (await isOfficialPaperCustomerEmergencyStopped(database, input.customerId)) {
    await restrictOfficialPaperPortfoliosForEmergency(database, {
      customerIds: [input.customerId],
      now: input.now,
    });
    return { activated: false, emergencyStopped: true };
  }
  const result = await database.query(`
    UPDATE official_paper_portfolios
    SET access_status = 'active', updated_at = $3
    WHERE membership_id = $1
      AND customer_id = $2
      AND access_status IS DISTINCT FROM 'active'
  `, [input.membershipId, input.customerId, input.now]);
  return { activated: true, emergencyStopped: false, changedPortfolios: result.rowCount ?? 0 };
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
    const portfolio = (await client.query<{
      id: string; customer_id: string; strategy_code: StrategyCode; access_status: OfficialPaperPortfolioState["access"];
      principal_usdt: string; cash_usdt: string; realized_pnl_usdt: string;
      realized_gross_pnl_usdt: string; realized_net_pnl_usdt: string; fees_usdt: string;
      membership_status: string; membership_expires_at: string | null; membership_grace_ends_at: string | null;
    }>(`
      SELECT portfolio.id, portfolio.customer_id, portfolio.strategy_code, portfolio.access_status,
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
      JOIN strategy_deployments AS deployment
        ON deployment.paper_portfolio_id = portfolio.id
      WHERE deployment.id = $1
      FOR UPDATE OF portfolio, membership
    `, [input.deploymentId])).rows[0];
    if (!portfolio) {
      await client.query("COMMIT");
      return null;
    }
    const intent = (await client.query<{
      id: string; portfolio_id: string; symbol: string; action: "buy" | "sell";
      requested_price: string | null; payload_json: Record<string, unknown>;
    }>(`
      SELECT id, portfolio_id, symbol, action, requested_price, payload_json
      FROM official_paper_order_intents
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
    const emergencyStopped = await isOfficialPaperCustomerEmergencyStopped(client, portfolio.customer_id);
    const settlementAccess = constrainedOfficialPaperAccess({
      storedAccess: portfolio.access_status,
      membershipAllowsNewEntries: currentMembershipAccess.newEntriesAllowed,
      emergencyStopped,
      hasOpenPositions: positions.rows.length > 0,
    });
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
      // 读组合自己的本金，不写死。实盘组合的本金是客户真实投入的资金，
      // 而按本金百分比算的配置上限就在这个值上（applyOfficialPaperFill）。
      principalUsdt: Number(portfolio.principal_usdt),
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
      const emergencyRejection = emergencyStopped && intent.action === "buy";
      const rejectionReason = emergencyRejection
        ? "当前范围处于紧急暂停，不能新增官方模拟盘持仓"
        : error instanceof Error ? error.message : "模拟盘风控拒绝";
      await client.query(`
        UPDATE official_paper_order_intents
        SET status = 'rejected', rejection_code = $2
        WHERE id = $1
      `, [intent.id, emergencyRejection
        ? OFFICIAL_PAPER_EMERGENCY_REJECTION_CODE
        : rejectionReason.slice(0, 120)]);
      await client.query("COMMIT");
      return { status: "rejected" as const, reason: rejectionReason };
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

    const finalAccess = constrainedOfficialPaperAccess({
      storedAccess: portfolio.access_status,
      membershipAllowsNewEntries: currentMembershipAccess.newEntriesAllowed,
      emergencyStopped,
      hasOpenPositions: next.positions.length > 0,
    });
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
    updated_at: Date; position_count: number; position_value_usdt: string; equity_usdt: string;
    unrealized_pnl_usdt: string;
    deployment_id: string | null; strategy_subscription_id: string | null;
    deployment_mode: "paper" | "shadow" | null; deployment_status: "active" | "paused" | "ended" | "failed" | null;
    last_cycle_sequence: string | null; last_candle_close_at: Date | null;
  }>(`
    SELECT portfolio.id, portfolio.membership_id, portfolio.strategy_code,
           portfolio.principal_usdt, portfolio.cash_usdt, portfolio.realized_pnl_usdt,
           portfolio.realized_gross_pnl_usdt, portfolio.realized_net_pnl_usdt,
           portfolio.fees_usdt, portfolio.access_status, portfolio.updated_at,
           count(position.id)::int AS position_count,
           round(COALESCE(sum(position.quantity * position.last_mark_price), 0), 12)::numeric(30,12)::text AS position_value_usdt,
           round(portfolio.cash_usdt + COALESCE(sum(position.quantity * position.last_mark_price), 0), 12)::numeric(30,12)::text AS equity_usdt,
           round(COALESCE(sum(position.unrealized_pnl_usdt), 0), 12)::numeric(30,12)::text AS unrealized_pnl_usdt,
           runtime.id AS deployment_id,
           runtime.strategy_subscription_id,
           runtime.mode AS deployment_mode,
           runtime.status AS deployment_status,
           runtime.last_cycle_sequence::text,
           runtime.last_candle_close_at
    FROM official_paper_portfolios AS portfolio
    LEFT JOIN official_paper_positions AS position
      ON position.portfolio_id = portfolio.id AND position.status = 'open'
    LEFT JOIN LATERAL (
      SELECT deployment.id,deployment.strategy_subscription_id,deployment.mode,
             deployment.status,deployment.last_cycle_sequence,deployment.last_candle_close_at
      FROM strategy_deployments AS deployment
      WHERE deployment.owner_user_id = portfolio.customer_id
        AND deployment.paper_portfolio_id = portfolio.id
        AND deployment.execution_product = 'spot_usdt'
        AND deployment.platform_strategy_code = portfolio.strategy_code
      ORDER BY deployment.updated_at DESC,deployment.id DESC
      LIMIT 1
    ) AS runtime ON true
    WHERE portfolio.customer_id = $1
    GROUP BY portfolio.id,runtime.id,runtime.strategy_subscription_id,runtime.mode,
             runtime.status,runtime.last_cycle_sequence,runtime.last_candle_close_at
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
    return {
      id: row.id,
      membershipId: row.membership_id,
      strategyCode: row.strategy_code,
      principalUsdt: row.principal_usdt,
      cashUsdt: row.cash_usdt,
      marketValueUsdt: row.position_value_usdt,
      equityUsdt: row.equity_usdt,
      realizedGrossPnlUsdt: row.realized_gross_pnl_usdt,
      realizedNetPnlUsdt: row.realized_net_pnl_usdt,
      unrealizedPnlUsdt: row.unrealized_pnl_usdt,
      feesUsdt: row.fees_usdt,
      access: row.access_status,
      runtime: {
        state: row.deployment_status ?? "not_started",
        deploymentId: row.deployment_id,
        subscriptionId: row.strategy_subscription_id,
        mode: row.deployment_mode,
        lastCycleSequence: Number(row.last_cycle_sequence ?? 0),
        lastDecisionAt: row.last_candle_close_at?.toISOString() ?? null,
      },
      openPositionCount: row.position_count,
      positions: positions.rows.filter((position) => position.portfolio_id === row.id).map((position) => ({
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity,
        averageEntryPrice: position.average_entry_price,
        costBasisUsdt: position.cost_basis_usdt,
        entryFeesUsdt: position.entry_fees_usdt,
        lastMarkPrice: position.last_mark_price,
        unrealizedPnlUsdt: position.unrealized_pnl_usdt,
        openedAt: position.opened_at.toISOString(),
      })),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export async function listOfficialPaperTrades(database: Queryable, input: {
  customerId: string;
  portfolioId?: string | null;
  cursor?: { filledAt: Date; id: string } | null;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const values: unknown[] = [input.customerId];
  let portfolioSql = "";
  if (input.portfolioId) {
    values.push(input.portfolioId);
    portfolioSql = `AND receipt.portfolio_id = $${values.length}`;
  }
  let cursorSql = "";
  if (input.cursor) {
    values.push(input.cursor.filledAt, input.cursor.id);
    cursorSql = `AND (receipt.filled_at, receipt.id) < ($${values.length - 1}, $${values.length})`;
  }
  values.push(limit + 1);
  const result = await database.query<{
    id: string; portfolio_id: string; strategy_code: StrategyCode; symbol: string; action: string;
    quantity: string; fill_price: string; notional_usdt: string; fee_usdt: string;
    allocated_entry_fee_usdt: string; realized_pnl_usdt: string;
    realized_gross_pnl_usdt: string; realized_net_pnl_usdt: string;
    decision_round_id: string; trace_id: string; filled_at: Date;
  }>(`
    SELECT receipt.id, receipt.portfolio_id, portfolio.strategy_code,
           receipt.symbol, receipt.action, receipt.quantity, receipt.fill_price,
           receipt.notional_usdt, receipt.fee_usdt, receipt.allocated_entry_fee_usdt,
           receipt.realized_pnl_usdt, receipt.realized_gross_pnl_usdt,
           receipt.realized_net_pnl_usdt,
           intent.runtime_cycle_id AS decision_round_id,
           receipt.trace_id, receipt.filled_at
    FROM official_paper_fill_receipts AS receipt
    JOIN official_paper_order_intents AS intent ON intent.id = receipt.intent_id
    JOIN official_paper_portfolios AS portfolio ON portfolio.id = receipt.portfolio_id
    WHERE portfolio.customer_id = $1 ${portfolioSql} ${cursorSql}
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
      quantity: row.quantity,
      fillPrice: row.fill_price,
      notionalUsdt: row.notional_usdt,
      feeUsdt: row.fee_usdt,
      allocatedEntryFeeUsdt: row.allocated_entry_fee_usdt,
      realizedGrossPnlUsdt: row.realized_gross_pnl_usdt,
      realizedNetPnlUsdt: row.realized_net_pnl_usdt,
      decisionRoundId: row.decision_round_id,
      traceId: row.trace_id,
      filledAt: row.filled_at.toISOString(),
    })),
    nextCursor: hasMore && rows.length
      ? { filledAt: rows.at(-1)!.filled_at, id: rows.at(-1)!.id }
      : null,
  };
}
