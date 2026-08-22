import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  lockOfficialPaperRuntimeAccess,
  OFFICIAL_PAPER_EMERGENCY_REJECTION_CODE,
} from "./official-paper-repository.ts";
import { resolveRuntimeExplanationPrompt, type RuntimeExplanationOutput } from "./runtime-explanations.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

type DeploymentRow = QueryResultRow & {
  id: string;
  owner_user_id: string;
  strategy_id: string;
  strategy_version_id: string;
  exchange_account_id: string | null;
  execution_product: "usdt_perpetual" | "spot_usdt";
  platform_strategy_code: "ai_conservative" | "ai_balanced" | "ai_aggressive" | null;
  membership_id: string | null;
  paper_portfolio_id: string | null;
  mode: "shadow" | "paper";
  status: "active" | "paused" | "ended" | "failed";
  validation_label: string;
  unverified_warning: boolean;
  last_cycle_sequence: string;
  last_candle_close_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  risk_state_json: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

function deploymentFromRow(row: DeploymentRow) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    strategyId: row.strategy_id,
    strategyVersionId: row.strategy_version_id,
    exchangeAccountId: row.exchange_account_id,
    executionProduct: row.execution_product,
    platformStrategyCode: row.platform_strategy_code,
    membershipId: row.membership_id,
    paperPortfolioId: row.paper_portfolio_id,
    mode: row.mode,
    status: row.status,
    validationLabel: row.validation_label,
    unverifiedWarning: row.unverified_warning,
    lastCycleSequence: Number(row.last_cycle_sequence),
    lastCandleCloseAt: row.last_candle_close_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    riskState: row.risk_state_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class StrategyDeploymentIdempotencyConflictError extends Error {
  constructor() {
    super("同一 Idempotency-Key 已用于不同的策略部署请求");
    this.name = "StrategyDeploymentIdempotencyConflictError";
  }
}

export class OfficialStrategyModeSwitchOpenPositionError extends Error {
  constructor() {
    super("官方策略仍有现货模拟持仓，不能切换运行模式或交易对");
    this.name = "OfficialStrategyModeSwitchOpenPositionError";
  }
}

export class OfficialStrategyGenericResumeBlockedError extends Error {
  constructor() {
    super("官方策略必须通过交易大厅重新校验会员、紧急停控与模拟组合后恢复");
    this.name = "OfficialStrategyGenericResumeBlockedError";
  }
}

export async function endConflictingOfficialStrategyDeployments(database: Queryable, input: {
  ownerUserId: string;
  strategyCode: "ai_conservative" | "ai_balanced" | "ai_aggressive";
  strategyId: string;
  strategyVersionId: string;
  mode: "shadow" | "paper";
  paperPortfolioId: string;
}) {
  const active = await database.query<{
    id: string; strategy_id: string; strategy_version_id: string; mode: "shadow" | "paper";
    paper_portfolio_id: string | null; strategy_subscription_id: string | null;
  }>(`
    SELECT id, strategy_id, strategy_version_id, mode,
           paper_portfolio_id, strategy_subscription_id
    FROM strategy_deployments
    WHERE owner_user_id = $1 AND platform_strategy_code = $2
      AND execution_product = 'spot_usdt' AND status IN ('active', 'paused')
    ORDER BY created_at, id
    FOR UPDATE
  `, [input.ownerUserId, input.strategyCode]);
  const conflicts = active.rows.filter((row) => !(
    row.strategy_id === input.strategyId
    && row.strategy_version_id === input.strategyVersionId
    && row.mode === input.mode
    && row.paper_portfolio_id === input.paperPortfolioId
  ));
  if (!conflicts.length) return { endedDeploymentIds: [], endedSubscriptionIds: [] };

  const portfolioIds = [...new Set([
    input.paperPortfolioId,
    ...conflicts.flatMap((row) => row.paper_portfolio_id ? [row.paper_portfolio_id] : []),
  ])];
  const position = await database.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM official_paper_positions
      WHERE portfolio_id = ANY($1::text[]) AND status = 'open'
    ) AS present
  `, [portfolioIds]);
  if (position.rows[0]?.present === true) throw new OfficialStrategyModeSwitchOpenPositionError();

  const deploymentIds = conflicts.map((row) => row.id);
  await database.query(`
    UPDATE strategy_deployments
    SET status = 'ended', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = ANY($1::text[]) AND owner_user_id = $2 AND status IN ('active', 'paused')
  `, [deploymentIds, input.ownerUserId]);
  return {
    endedDeploymentIds: deploymentIds,
    endedSubscriptionIds: [...new Set(conflicts.flatMap((row) => (
      row.strategy_subscription_id ? [row.strategy_subscription_id] : []
    )))],
  };
}

export async function createStrategyDeployment(database: Queryable, input: {
  ownerUserId: string;
  strategyId: string;
  strategyVersionId: string;
  exchangeAccountId?: string | null;
  mode: "shadow" | "paper";
  validationLabel: "UNVERIFIED" | "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";
  idempotencyKey: string;
  riskAcknowledged: boolean;
  strategySubscriptionId?: string | null;
  positionSizePct?: number | null;
  stopLossPctOverride?: number | null;
  executionProduct?: "usdt_perpetual" | "spot_usdt";
  platformStrategyCode?: "ai_conservative" | "ai_balanced" | "ai_aggressive" | null;
  membershipId?: string | null;
  paperPortfolioId?: string | null;
}) {
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) throw new Error("部署幂等键长度无效");
  const executionProduct = input.executionProduct ?? "usdt_perpetual";
  if (executionProduct === "spot_usdt") {
    if (!input.platformStrategyCode || !input.membershipId || !input.paperPortfolioId || input.exchangeAccountId) {
      throw new Error("官方策略部署缺少安全组合绑定或错误使用客户交易账户");
    }
    const portfolio = await database.query<{ present: boolean }>(`
      SELECT true AS present
      FROM official_paper_portfolios
      WHERE id = $1 AND membership_id = $2 AND customer_id = $3 AND strategy_code = $4
      FOR KEY SHARE
    `, [input.paperPortfolioId, input.membershipId, input.ownerUserId, input.platformStrategyCode]);
    if (portfolio.rows[0]?.present !== true) throw new Error("官方策略模拟组合与会员、客户归属不匹配");
  } else if (
    !input.exchangeAccountId?.trim()
    || input.platformStrategyCode != null
    || input.membershipId != null
    || input.paperPortfolioId != null
  ) {
    throw new Error("非官方策略部署必须绑定客户交易账户且不得携带官方策略组合绑定");
  }
  const result = await database.query<DeploymentRow>(`
    INSERT INTO strategy_deployments AS existing (
      id, owner_user_id, strategy_id, strategy_version_id, exchange_account_id,
      mode, validation_label, unverified_warning, idempotency_key, risk_acknowledged_at,
      strategy_subscription_id, position_size_pct, stop_loss_pct_override,
      execution_product, platform_strategy_code, membership_id, paper_portfolio_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN now() ELSE NULL END, $11, $12, $13, $14, $15, $16, $17)
    ON CONFLICT (owner_user_id, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    WHERE existing.strategy_id = EXCLUDED.strategy_id
      AND existing.strategy_version_id = EXCLUDED.strategy_version_id
      AND existing.exchange_account_id IS NOT DISTINCT FROM EXCLUDED.exchange_account_id
      AND existing.mode = EXCLUDED.mode
      AND existing.validation_label = EXCLUDED.validation_label
      AND existing.strategy_subscription_id IS NOT DISTINCT FROM EXCLUDED.strategy_subscription_id
      AND existing.position_size_pct IS NOT DISTINCT FROM EXCLUDED.position_size_pct
      AND existing.stop_loss_pct_override IS NOT DISTINCT FROM EXCLUDED.stop_loss_pct_override
      AND existing.execution_product = EXCLUDED.execution_product
      AND existing.platform_strategy_code IS NOT DISTINCT FROM EXCLUDED.platform_strategy_code
      AND existing.membership_id IS NOT DISTINCT FROM EXCLUDED.membership_id
      AND existing.paper_portfolio_id IS NOT DISTINCT FROM EXCLUDED.paper_portfolio_id
    RETURNING *
  `, [
    crypto.randomUUID(), input.ownerUserId, input.strategyId, input.strategyVersionId,
    input.exchangeAccountId ?? null, input.mode, input.validationLabel,
    input.validationLabel !== "STANDARD_VERIFIED", input.idempotencyKey, input.riskAcknowledged,
    input.strategySubscriptionId ?? null, input.positionSizePct ?? null, input.stopLossPctOverride ?? null,
    executionProduct, input.platformStrategyCode ?? null,
    input.membershipId ?? null, input.paperPortfolioId ?? null,
  ]);
  if (!result.rows[0]) throw new StrategyDeploymentIdempotencyConflictError();
  return deploymentFromRow(result.rows[0]);
}

export async function getOwnedStrategyDeployment(database: Queryable, input: {
  deploymentId: string;
  ownerUserId: string;
}) {
  const result = await database.query<DeploymentRow>(`
    SELECT * FROM strategy_deployments WHERE id = $1 AND owner_user_id = $2
  `, [input.deploymentId, input.ownerUserId]);
  return result.rows[0] ? deploymentFromRow(result.rows[0]) : null;
}

export async function changeStrategyDeploymentStatus(database: Queryable, input: {
  deploymentId: string;
  ownerUserId: string;
  action: "pause" | "resume";
}) {
  const desired = input.action === "pause" ? "paused" : "active";
  const allowed = input.action === "pause" ? "active" : "paused";
  const result = await database.query<DeploymentRow>(`
    UPDATE strategy_deployments
    SET status = $3,
        next_cycle_at = CASE WHEN $3 = 'active' THEN now() ELSE next_cycle_at END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = $1 AND owner_user_id = $2 AND status = $4
      AND ($5::boolean = false OR execution_product <> 'spot_usdt')
    RETURNING *
  `, [input.deploymentId, input.ownerUserId, desired, allowed, input.action === "resume"]);
  if (!result.rows[0] && input.action === "resume") {
    const official = await database.query<{ present: boolean }>(`
      SELECT true AS present FROM strategy_deployments
      WHERE id = $1 AND owner_user_id = $2 AND execution_product = 'spot_usdt'
    `, [input.deploymentId, input.ownerUserId]);
    if (official.rows[0]?.present === true) throw new OfficialStrategyGenericResumeBlockedError();
  }
  if (!result.rows[0]) throw new Error(input.action === "pause" ? "部署不存在或当前无法暂停" : "部署不存在或当前无法恢复");
  return deploymentFromRow(result.rows[0]);
}

export async function listOwnedRuntimeCycles(database: Queryable, input: {
  deploymentId: string;
  ownerUserId: string;
  afterSequence?: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  const cycles = await database.query<{
    id: string; sequence: string; candle_open_time: Date; candle_close_time: Date;
    status: string; decision_json: Record<string, unknown>; order_intent_json: Record<string, unknown> | null;
    trace_id: string; started_at: Date; completed_at: Date;
  }>(`
    SELECT cycle.id, cycle.sequence, cycle.candle_open_time, cycle.candle_close_time,
           cycle.status, cycle.decision_json, cycle.order_intent_json,
           cycle.trace_id, cycle.started_at, cycle.completed_at
    FROM strategy_runtime_cycles AS cycle
    JOIN strategy_deployments AS deployment ON deployment.id = cycle.deployment_id
    WHERE cycle.deployment_id = $1 AND deployment.owner_user_id = $2 AND cycle.sequence > $3
    ORDER BY cycle.sequence
    LIMIT $4
  `, [input.deploymentId, input.ownerUserId, input.afterSequence ?? 0, limit]);
  const ids = cycles.rows.map(row => row.id);
  const events = ids.length ? await database.query<{
    cycle_id: string; sequence: number; role: string; event_type: string; conclusion: string;
    evidence_json: Record<string, unknown>; duration_ms: number; llm_used: boolean; model_name: string | null;
    explanation_status: string; explanation_json: RuntimeExplanationOutput | null;
    explanation_model_name: string | null; explanation_duration_ms: number | null;
    explanation_error_code: string | null; explanation_updated_at: Date | null; created_at: Date;
  }>(`
    SELECT cycle_id, sequence, role, event_type, conclusion, evidence_json,
           duration_ms, llm_used, model_name, explanation_status, explanation_json,
           explanation_model_name, explanation_duration_ms, explanation_error_code,
           explanation_updated_at, created_at
    FROM strategy_runtime_events WHERE cycle_id = ANY($1::text[])
    ORDER BY cycle_id, sequence
  `, [ids]) : { rows: [] };
  const byCycle = new Map<string, typeof events.rows>();
  for (const event of events.rows) byCycle.set(event.cycle_id, [...(byCycle.get(event.cycle_id) || []), event]);
  return cycles.rows.map(row => ({
    id: row.id,
    sequence: Number(row.sequence),
    candleOpenTime: row.candle_open_time,
    candleCloseTime: row.candle_close_time,
    status: row.status,
    decision: row.decision_json,
    orderIntent: row.order_intent_json,
    traceId: row.trace_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    events: (byCycle.get(row.id) || []).map(event => ({
      sequence: event.sequence,
      role: event.role,
      type: event.event_type,
      conclusion: event.conclusion,
      evidence: event.evidence_json,
      durationMs: event.duration_ms,
      llmUsed: event.llm_used,
      modelName: event.model_name,
      explanationStatus: event.explanation_status,
      explanation: event.explanation_json,
      explanationModelName: event.explanation_model_name,
      explanationDurationMs: event.explanation_duration_ms,
      explanationErrorCode: event.explanation_error_code,
      explanationUpdatedAt: event.explanation_updated_at,
      createdAt: event.created_at,
    })),
  }));
}

export async function leaseNextStrategyDeployment(database: Queryable, input: {
  workerId: string;
  now: Date;
  leaseSeconds: number;
}) {
  if (!input.workerId.trim() || input.workerId.length > 120) throw new Error("Runtime Worker ID 无效");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) throw new Error("Runtime 租约时长无效");
  const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
  const result = await database.query<{
    id: string; owner_user_id: string; strategy_id: string; strategy_version_id: string;
    exchange_account_id: string | null; mode: "shadow" | "paper"; validation_label: string;
    fencing_token: string; last_candle_close_at: Date | null; risk_state_json: Record<string, unknown>;
    specification_json: string; exchange: string | null; position_size_pct: number | null; stop_loss_pct_override: number | null;
    execution_product: "usdt_perpetual" | "spot_usdt";
    platform_strategy_code: "ai_conservative" | "ai_balanced" | "ai_aggressive" | null;
    membership_id: string | null; paper_portfolio_id: string | null;
    membership_status: string | null; membership_expires_at: string | null; membership_grace_ends_at: string | null;
  }>(`
    WITH picked AS (
      SELECT id FROM strategy_deployments
      WHERE status = 'active' AND execution_product = 'spot_usdt' AND next_cycle_at <= $1
        AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
      ORDER BY next_cycle_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE strategy_deployments AS deployment
    SET lease_owner = $2, lease_expires_at = $3,
        fencing_token = deployment.fencing_token + 1, updated_at = $1
    FROM picked, strategy_versions AS version
    WHERE deployment.id = picked.id
      AND version.id = deployment.strategy_version_id
      AND deployment.execution_product = 'spot_usdt'
      AND deployment.exchange_account_id IS NULL
      AND deployment.platform_strategy_code IS NOT NULL
      AND deployment.membership_id IS NOT NULL
      AND deployment.paper_portfolio_id IS NOT NULL
    RETURNING deployment.id, deployment.owner_user_id, deployment.strategy_id,
      deployment.strategy_version_id, deployment.exchange_account_id, deployment.mode,
      deployment.validation_label, deployment.fencing_token,
      deployment.last_candle_close_at, deployment.risk_state_json,
      deployment.position_size_pct, deployment.stop_loss_pct_override,
      deployment.execution_product, deployment.platform_strategy_code,
      deployment.membership_id, deployment.paper_portfolio_id,
      version.specification_json,
      NULL::text AS exchange,
      (SELECT membership.status FROM memberships AS membership
       WHERE membership.id = deployment.membership_id) AS membership_status,
      (SELECT membership.expires_at FROM memberships AS membership
       WHERE membership.id = deployment.membership_id) AS membership_expires_at,
      (SELECT membership.grace_ends_at FROM memberships AS membership
       WHERE membership.id = deployment.membership_id) AS membership_grace_ends_at
  `, [input.now, input.workerId, expiresAt]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    strategyId: row.strategy_id,
    strategyVersionId: row.strategy_version_id,
    exchangeAccountId: row.exchange_account_id,
    mode: row.mode,
    validationLabel: row.validation_label,
    fencingToken: Number(row.fencing_token),
    lastCandleCloseAt: row.last_candle_close_at,
    riskState: row.risk_state_json,
    positionSizePct: row.position_size_pct === null ? null : Number(row.position_size_pct),
    stopLossPctOverride: row.stop_loss_pct_override === null ? null : Number(row.stop_loss_pct_override),
    specification: JSON.parse(row.specification_json) as unknown,
    executionProduct: row.execution_product,
    platformStrategyCode: row.platform_strategy_code,
    membershipId: row.membership_id,
    paperPortfolioId: row.paper_portfolio_id,
    membershipStatus: row.membership_status,
    membershipExpiresAt: row.membership_expires_at,
    membershipGraceEndsAt: row.membership_grace_ends_at,
    exchange: row.exchange?.toLowerCase() ?? null,
  };
}

export async function renewStrategyRuntimeLease(database: Queryable, input: {
  deploymentId: string;
  workerId: string;
  fencingToken: number;
  now: Date;
  leaseSeconds: number;
}) {
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) {
    throw new Error("Runtime 续租时长无效");
  }
  const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
  const result = await database.query(`
    UPDATE strategy_deployments
    SET lease_expires_at = $5, updated_at = $4
    WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
      AND status = 'active' AND execution_product = 'spot_usdt'
      AND exchange_account_id IS NULL AND lease_expires_at > $4
  `, [input.deploymentId, input.workerId, input.fencingToken, input.now, expiresAt]);
  if (result.rowCount !== 1) throw new Error("Runtime Worker 续租失败：租约或 fencing token 已失效");
  return { leaseExpiresAt: expiresAt };
}

export async function loadOpenPaperPosition(database: Queryable, deploymentId: string) {
  const result = await database.query<{
    id: string; side: "long" | "short"; quantity: string; entry_price: string;
    fees_usdt: string; funding_usdt: string;
  }>(`
    SELECT id, side, quantity, entry_price, fees_usdt, funding_usdt
    FROM strategy_paper_positions
    WHERE deployment_id = $1 AND status = 'open'
    LIMIT 1
  `, [deploymentId]);
  const row = result.rows[0];
  return row ? {
    id: row.id,
    side: row.side,
    quantity: Number(row.quantity),
    entryPrice: Number(row.entry_price),
    feesUsdt: Number(row.fees_usdt),
    fundingUsdt: Number(row.funding_usdt),
  } : null;
}

export async function applyPaperFundingRates(database: Pool, input: {
  deploymentId: string;
  rates: Array<{ time: number; rate: number }>;
}) {
  if (input.rates.some(item => !Number.isFinite(item.time) || !Number.isFinite(item.rate) || Math.abs(item.rate) > 0.1)) {
    throw new Error("模拟盘资金费率数据无效");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const position = (await client.query<{
      id: string; side: "long" | "short"; quantity: string; entry_price: string; opened_at: Date;
    }>(`
      SELECT id, side, quantity, entry_price, opened_at
      FROM strategy_paper_positions
      WHERE deployment_id = $1 AND status = 'open'
      FOR UPDATE LIMIT 1
    `, [input.deploymentId])).rows[0];
    if (!position) {
      await client.query("COMMIT");
      return { applied: 0, fundingCostUsdt: 0 };
    }
    const notional = Number(position.quantity) * Number(position.entry_price);
    let fundingCostUsdt = 0;
    let applied = 0;
    for (const item of [...input.rates].sort((left, right) => left.time - right.time)) {
      if (item.time < position.opened_at.getTime()) continue;
      const cost = notional * item.rate * (position.side === "long" ? 1 : -1);
      const inserted = await client.query(`
        INSERT INTO strategy_paper_funding_accruals (
          id, deployment_id, position_id, funding_time,
          funding_rate, notional_usdt, funding_cost_usdt
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (position_id, funding_time) DO NOTHING
        RETURNING id
      `, [crypto.randomUUID(), input.deploymentId, position.id, new Date(item.time), item.rate, notional, cost]);
      if (inserted.rows[0]) {
        applied += 1;
        fundingCostUsdt += cost;
      }
    }
    if (applied) {
      await client.query(`
        UPDATE strategy_paper_positions
        SET funding_usdt = funding_usdt + $2, updated_at = now()
        WHERE id = $1
      `, [position.id, fundingCostUsdt]);
    }
    await client.query("COMMIT");
    return { applied, fundingCostUsdt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function settlePendingPaperOrder(database: Pool, input: {
  deploymentId: string;
  fillPrice?: number;
  fillTime: Date;
  timing: "next_candle_open" | "intrabar_threshold";
}) {
  if (input.fillPrice !== undefined && (!Number.isFinite(input.fillPrice) || input.fillPrice <= 0)) {
    throw new Error("模拟成交价格无效");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query<{
      id: string; cycle_id: string; action: "enter_long" | "enter_short" | "exit";
      requested_price: string | null; payload_json: Record<string, unknown>;
    }>(`
      SELECT id, cycle_id, action, requested_price, payload_json
      FROM strategy_paper_order_intents
      WHERE deployment_id = $1 AND status = 'pending' AND execution_timing = $2
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `, [input.deploymentId, input.timing])).rows[0];
    if (!order) {
      await client.query("COMMIT");
      return null;
    }
    const fillPrice = input.fillPrice ?? Number(order.requested_price);
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) throw new Error("模拟成交价格无效");
    const position = (await client.query<{
      id: string; side: "long" | "short"; quantity: string; entry_price: string; fees_usdt: string; funding_usdt: string;
    }>(`
      SELECT id, side, quantity, entry_price, fees_usdt, funding_usdt
      FROM strategy_paper_positions
      WHERE deployment_id = $1 AND status = 'open'
      FOR UPDATE
      LIMIT 1
    `, [input.deploymentId])).rows[0];
    if (order.action === "exit") {
      if (!position) throw new Error("模拟平仓意图不存在对应持仓");
      const quantity = Number(position.quantity);
      const entryPrice = Number(position.entry_price);
      const gross = position.side === "long"
        ? (fillPrice - entryPrice) * quantity
        : (entryPrice - fillPrice) * quantity;
      const configuredFee = Number(order.payload_json.takerFeeRate);
      const takerFeeRate = Number.isFinite(configuredFee) && configuredFee >= 0 && configuredFee <= 0.01 ? configuredFee : 0.0007;
      const exitFee = fillPrice * quantity * takerFeeRate;
      const net = gross - Number(position.fees_usdt) - Number(position.funding_usdt) - exitFee;
      await client.query(`
        UPDATE strategy_paper_positions
        SET status = 'closed', exit_price = $2, closed_cycle_id = $3,
            fees_usdt = fees_usdt + $4, realized_net_pnl_usdt = $5,
            closed_at = $6, updated_at = now()
        WHERE id = $1
      `, [position.id, fillPrice, order.cycle_id, exitFee, net, input.fillTime]);
    } else {
      if (position) throw new Error("同一部署同一时间只能有一个净持仓");
      const positionSizePct = Number(order.payload_json.positionSizePct);
      const initialEquityUsdt = Number(order.payload_json.initialEquityUsdt || 10_000);
      const notional = initialEquityUsdt * positionSizePct / 100;
      const quantity = notional / fillPrice;
      const configuredFee = Number(order.payload_json.takerFeeRate);
      const takerFeeRate = Number.isFinite(configuredFee) && configuredFee >= 0 && configuredFee <= 0.01 ? configuredFee : 0.0007;
      const fee = notional * takerFeeRate;
      await client.query(`
        INSERT INTO strategy_paper_positions (
          id, deployment_id, side, status, quantity, entry_price,
          opened_cycle_id, fees_usdt, opened_at
        ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)
      `, [crypto.randomUUID(), input.deploymentId, order.action === "enter_long" ? "long" : "short", quantity, fillPrice, order.cycle_id, fee, input.fillTime]);
    }
    await client.query(`UPDATE strategy_paper_order_intents SET status = 'filled', filled_at = $2 WHERE id = $1`, [order.id, input.fillTime]);
    if (order.action === "exit") {
      const totals = (await client.query<{
        total_pnl: string; today_pnl: string; recent_results: number[];
      }>(`
        SELECT
          COALESCE(sum(realized_net_pnl_usdt), 0)::text AS total_pnl,
          COALESCE(sum(realized_net_pnl_usdt) FILTER (WHERE closed_at >= date_trunc('day', $2::timestamptz)), 0)::text AS today_pnl,
          ARRAY(SELECT realized_net_pnl_usdt::double precision
                FROM strategy_paper_positions
                WHERE deployment_id = $1 AND status = 'closed'
                ORDER BY closed_at DESC, id DESC LIMIT 20) AS recent_results
        FROM strategy_paper_positions
        WHERE deployment_id = $1 AND status = 'closed'
      `, [input.deploymentId, input.fillTime])).rows[0];
      const deployment = (await client.query<{ risk_state_json: Record<string, unknown> }>(`
        SELECT risk_state_json FROM strategy_deployments WHERE id = $1 FOR UPDATE
      `, [input.deploymentId])).rows[0];
      const equity = 10_000 + Number(totals.total_pnl);
      const previousPeak = Number(deployment?.risk_state_json.peakEquityUsdt || 10_000);
      const peakEquityUsdt = Math.max(previousPeak, equity);
      const consecutiveLosses = (totals.recent_results || []).findIndex(value => value >= 0);
      const nextRiskState = {
        ...deployment?.risk_state_json,
        equityUsdt: equity,
        peakEquityUsdt,
        drawdownPct: peakEquityUsdt > 0 ? Math.max(0, (peakEquityUsdt - equity) / peakEquityUsdt * 100) : 100,
        dailyLossPct: Math.max(0, -Number(totals.today_pnl) / 10_000 * 100),
        consecutiveLosses: consecutiveLosses === -1 ? (totals.recent_results || []).length : consecutiveLosses,
      };
      await client.query(`UPDATE strategy_deployments SET risk_state_json = $2::jsonb WHERE id = $1`, [input.deploymentId, JSON.stringify(nextRiskState)]);
    }
    await client.query("COMMIT");
    return { orderId: order.id, action: order.action };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeStrategyRuntimeCycle(database: Pool, input: {
  cycleId: string;
  deploymentId: string;
  workerId: string;
  fencingToken: number;
  candleOpenTime: Date;
  candleCloseTime: Date;
  marketDataSnapshotId: string;
  decision: Record<string, unknown>;
  orderIntent: Record<string, unknown> | null;
  events: Array<{
    sequence: number; role: string; conclusion: string; evidence: Record<string, unknown>;
    durationMs: number; llmUsed: boolean; modelName?: string | null;
  }>;
  traceId: string;
  startedAt: Date;
  nextCycleAt: Date;
  positionSizePct: number;
  takerFeeRate?: number;
  symbol?: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
  riskPerTradePct?: number;
}) {
  if (input.events.length !== 7) throw new Error("每个运行周期必须保存七个 Agent 事件");
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; sequence: string }>(`
      SELECT id, sequence FROM strategy_runtime_cycles
      WHERE deployment_id = $1 AND candle_close_time = $2
    `, [input.deploymentId, input.candleCloseTime]);
    if (existing.rows[0]) {
      await client.query(`
        UPDATE strategy_deployments SET lease_owner = NULL, lease_expires_at = NULL,
          next_cycle_at = $3, updated_at = now()
        WHERE id = $1 AND fencing_token = $2
      `, [input.deploymentId, input.fencingToken, input.nextCycleAt]);
      await client.query("COMMIT");
      return { id: existing.rows[0].id, sequence: Number(existing.rows[0].sequence), duplicate: true };
    }
    const deployment = await client.query<{
      last_cycle_sequence: string; mode: "shadow" | "paper";
      execution_product: "usdt_perpetual" | "spot_usdt";
      paper_portfolio_id: string | null;
    }>(`
      UPDATE strategy_deployments
      SET last_cycle_sequence = last_cycle_sequence + 1,
          last_candle_close_at = $4,
          next_cycle_at = $5,
          lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = NULL, last_error_message = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND status = 'active'
      RETURNING last_cycle_sequence, mode, execution_product, paper_portfolio_id
    `, [input.deploymentId, input.workerId, input.fencingToken, input.candleCloseTime, input.nextCycleAt]);
    if (!deployment.rows[0]) throw new Error("Runtime Worker 租约或 fencing token 已失效");
    const sequence = Number(deployment.rows[0].last_cycle_sequence);
    await client.query(`
      INSERT INTO strategy_runtime_cycles (
        id, deployment_id, sequence, fencing_token, candle_open_time, candle_close_time,
        market_data_snapshot_id, status, decision_json, order_intent_json,
        trace_id, started_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8::jsonb, $9::jsonb, $10, $11)
    `, [input.cycleId, input.deploymentId, sequence, input.fencingToken, input.candleOpenTime, input.candleCloseTime,
      input.marketDataSnapshotId, JSON.stringify(input.decision), input.orderIntent ? JSON.stringify(input.orderIntent) : null,
      input.traceId, input.startedAt]);
    for (const event of input.events) {
      await client.query(`
        INSERT INTO strategy_runtime_events (
          id, cycle_id, sequence, role, event_type, conclusion, evidence_json,
          duration_ms, llm_used, model_name
        ) VALUES ($1, $2, $3, $4, 'agent_completed', $5, $6::jsonb, $7, $8, $9)
      `, [crypto.randomUUID(), input.cycleId, event.sequence, event.role, event.conclusion,
        JSON.stringify(event.evidence), event.durationMs, event.llmUsed, event.modelName ?? null]);
    }
    await enqueueRuntimeExplanationJobs(client, {
      deploymentId: input.deploymentId,
      cycleId: input.cycleId,
      candleCloseTime: input.candleCloseTime,
      decision: input.decision,
      events: input.events,
    });
    if (input.orderIntent) {
      let status: "shadowed" | "pending" | "rejected" = deployment.rows[0].mode === "shadow" ? "shadowed" : "pending";
      if (deployment.rows[0].execution_product === "spot_usdt") {
        const action = String(input.orderIntent.action);
        if (action === "enter_short") throw new Error("官方现货策略禁止生成空头意图");
        if (action !== "enter_long" && action !== "exit") throw new Error("官方现货策略订单动作无效");
        if (!deployment.rows[0].paper_portfolio_id || !input.symbol) throw new Error("官方模拟盘组合或交易对缺失");
        if (!Number.isFinite(input.riskPerTradePct) || Number(input.riskPerTradePct) <= 0) throw new Error("官方模拟盘单笔风险合同缺失");
        const runtimeAccess = await lockOfficialPaperRuntimeAccess(client, {
          portfolioId: deployment.rows[0].paper_portfolio_id,
          asOf: input.startedAt,
        });
        const rejectionCode = deployment.rows[0].mode === "paper"
          && action === "enter_long"
          && runtimeAccess.access !== "active"
          ? runtimeAccess.emergencyStopped
            ? OFFICIAL_PAPER_EMERGENCY_REJECTION_CODE
            : "OFFICIAL_PAPER_ACCESS_RESTRICTED"
          : null;
        if (rejectionCode) status = "rejected";
        await client.query(`
          INSERT INTO official_paper_order_intents (
            id, portfolio_id, deployment_id, runtime_cycle_id,
            idempotency_key, symbol, action, execution_timing,
            requested_price, status, rejection_code, payload_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          ON CONFLICT (idempotency_key) DO NOTHING
        `, [crypto.randomUUID(), deployment.rows[0].paper_portfolio_id, input.deploymentId, input.cycleId,
          String(input.orderIntent.idempotencyKey), input.symbol, action === "enter_long" ? "buy" : "sell",
          String(input.orderIntent.executionTiming), input.orderIntent.requestedPrice ?? null,
          status, rejectionCode, JSON.stringify({
            mode: input.orderIntent.mode,
            quoteAmountUsdt: 10_000 * Number(input.riskPerTradePct) / 100,
            takerFeeRate: input.takerFeeRate ?? 0.001,
            traceId: input.traceId,
            customerExchangeAccountUsed: false,
          })]);
      } else {
        await client.query(`
          INSERT INTO strategy_paper_order_intents (
            id, deployment_id, cycle_id, idempotency_key, action,
            execution_timing, requested_price, status, payload_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          ON CONFLICT (idempotency_key) DO NOTHING
        `, [crypto.randomUUID(), input.deploymentId, input.cycleId,
          String(input.orderIntent.idempotencyKey), String(input.orderIntent.action),
          String(input.orderIntent.executionTiming), input.orderIntent.requestedPrice ?? null,
          status, JSON.stringify({
            ...input.orderIntent,
            positionSizePct: input.positionSizePct,
            initialEquityUsdt: 10_000,
            takerFeeRate: input.takerFeeRate ?? 0.0007,
          })]);
      }
    }
    await client.query("COMMIT");
    return { id: input.cycleId, sequence, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const runtimeExplanationEventRole = {
  market_summary: "market_data",
  adversarial_explanation: "adversarial_review",
  risk_explanation: "risk",
} as const;

type RuntimeExplanationRole = keyof typeof runtimeExplanationEventRole;

async function enqueueRuntimeExplanationJobs(client: PoolClient, input: {
  deploymentId: string;
  cycleId: string;
  candleCloseTime: Date;
  decision: Record<string, unknown>;
  events: Array<{ role: string; evidence: Record<string, unknown> }>;
}) {
  const bindings = await client.query<{
    role: RuntimeExplanationRole;
    revision_id: string;
  }>(`
    SELECT binding.role, revision.id AS revision_id
    FROM runtime_explanation_bindings AS binding
    JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
    JOIN llm_profile_revisions AS revision ON revision.id = profile.current_revision_id
    WHERE binding.enabled = true
      AND profile.enabled = true
      AND revision.enabled = true
      AND revision.encrypted_api_key <> ''
  `);
  if (!bindings.rows.length) return;

  const currentMarketState = String(input.events.find(event => event.role === "market_data")?.evidence.marketState ?? "unknown");
  const previousMarketSummary = await client.query<{
    candle_close_time: Date;
    market_state: string | null;
  }>(`
    SELECT cycle.candle_close_time,
           event.evidence_json->>'marketState' AS market_state
    FROM strategy_runtime_explanation_jobs AS job
    JOIN strategy_runtime_cycles AS cycle ON cycle.id = job.cycle_id
    JOIN strategy_runtime_events AS event
      ON event.cycle_id = cycle.id AND event.role = 'market_data'
    WHERE cycle.deployment_id = $1
      AND job.explanation_role = 'market_summary'
      AND cycle.id <> $2
    ORDER BY cycle.candle_close_time DESC
    LIMIT 1
  `, [input.deploymentId, input.cycleId]);
  const previous = previousMarketSummary.rows[0];
  const marketSummaryDue = !previous
    || previous.market_state !== currentMarketState
    || input.candleCloseTime.getTime() - previous.candle_close_time.getTime() >= 4 * 3_600_000;
  const action = String(input.decision.action ?? "hold");
  const explanationTriggered = action !== "hold" || input.decision.riskApproved === false;
  const requestedRoles = new Set<RuntimeExplanationRole>();
  if (marketSummaryDue) requestedRoles.add("market_summary");
  if (explanationTriggered) {
    requestedRoles.add("adversarial_explanation");
    requestedRoles.add("risk_explanation");
  }

  for (const binding of bindings.rows) {
    if (!requestedRoles.has(binding.role)) continue;
    const eventRole = runtimeExplanationEventRole[binding.role];
    const prompt = await resolveRuntimeExplanationPrompt(binding.role);
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO strategy_runtime_explanation_jobs (
        id, cycle_id, event_role, explanation_role, profile_revision_id,
        prompt_version, prompt_sha256
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (cycle_id, event_role) DO NOTHING
      RETURNING id
    `, [crypto.randomUUID(), input.cycleId, eventRole, binding.role, binding.revision_id, prompt.version, prompt.hash]);
    if (inserted.rows[0]) {
      await client.query(`
        UPDATE strategy_runtime_events
        SET explanation_status = 'pending', explanation_updated_at = now()
        WHERE cycle_id = $1 AND role = $2
      `, [input.cycleId, eventRole]);
    }
  }
}

export async function leaseNextRuntimeExplanationJob(database: Pool, input: {
  workerId: string;
  now: Date;
  leaseSeconds: number;
}) {
  if (!input.workerId.trim() || input.workerId.length > 120) throw new Error("运行时解释 Worker ID 无效");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) {
    throw new Error("运行时解释租约时长无效");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
    const result = await client.query<{
      id: string;
      cycle_id: string;
      event_role: "market_data" | "adversarial_review" | "risk";
      explanation_role: RuntimeExplanationRole;
      profile_revision_id: string;
      prompt_version: string;
      prompt_sha256: string;
      fencing_token: string;
      attempt_count: number;
      deterministic_conclusion: string;
      deterministic_evidence: Record<string, unknown>;
      decision_json: Record<string, unknown>;
      trace_id: string;
      deployment_id: string;
      strategy_version_id: string;
      candle_close_time: Date;
    }>(`
      WITH picked AS (
        SELECT id FROM strategy_runtime_explanation_jobs
        WHERE next_attempt_at <= $1
          AND (
            status IN ('pending', 'retry_wait')
            OR (status = 'running' AND lease_expires_at <= $1)
          )
        ORDER BY next_attempt_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE strategy_runtime_explanation_jobs AS job
      SET status = 'running', lease_owner = $2, lease_expires_at = $3,
          fencing_token = job.fencing_token + 1,
          attempt_count = job.attempt_count + 1,
          updated_at = $1
      FROM picked, strategy_runtime_cycles AS cycle,
           strategy_runtime_events AS event, strategy_deployments AS deployment
      WHERE job.id = picked.id
        AND cycle.id = job.cycle_id
        AND event.cycle_id = cycle.id AND event.role = job.event_role
        AND deployment.id = cycle.deployment_id
      RETURNING job.id, job.cycle_id, job.event_role, job.explanation_role,
                job.profile_revision_id, job.prompt_version, job.prompt_sha256,
                job.fencing_token, job.attempt_count,
                event.conclusion AS deterministic_conclusion,
                event.evidence_json AS deterministic_evidence,
                cycle.decision_json, cycle.trace_id, cycle.candle_close_time,
                deployment.id AS deployment_id, deployment.strategy_version_id
    `, [input.now, input.workerId, expiresAt]);
    const row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(`
      UPDATE strategy_runtime_events
      SET explanation_status = 'running', explanation_updated_at = $3
      WHERE cycle_id = $1 AND role = $2
    `, [row.cycle_id, row.event_role, input.now]);
    await client.query("COMMIT");
    return {
      id: row.id,
      cycleId: row.cycle_id,
      eventRole: row.event_role,
      explanationRole: row.explanation_role,
      profileRevisionId: row.profile_revision_id,
      promptVersion: row.prompt_version,
      promptHash: row.prompt_sha256,
      fencingToken: Number(row.fencing_token),
      attemptCount: row.attempt_count,
      context: {
        deterministicConclusion: row.deterministic_conclusion,
        evidence: row.deterministic_evidence,
        decision: row.decision_json,
        references: {
          deploymentId: row.deployment_id,
          strategyVersionId: row.strategy_version_id,
          cycleId: row.cycle_id,
          traceId: row.trace_id,
          candleCloseTime: row.candle_close_time.toISOString(),
        },
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeRuntimeExplanationJob(database: Pool, input: {
  jobId: string;
  workerId: string;
  fencingToken: number;
  output: RuntimeExplanationOutput;
  modelName: string;
  durationMs: number;
}) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ cycle_id: string; event_role: string }>(`
      UPDATE strategy_runtime_explanation_jobs
      SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = NULL, last_error_message = NULL,
          completed_at = now(), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND status = 'running'
      RETURNING cycle_id, event_role
    `, [input.jobId, input.workerId, input.fencingToken]);
    const row = updated.rows[0];
    if (!row) throw new Error("运行时解释 Worker 租约或 fencing token 已失效");
    await client.query(`
      UPDATE strategy_runtime_events
      SET explanation_status = 'completed', explanation_json = $3::jsonb,
          explanation_model_name = $4, explanation_duration_ms = $5,
          explanation_error_code = NULL, explanation_updated_at = now(),
          llm_used = true, model_name = $4
      WHERE cycle_id = $1 AND role = $2
    `, [row.cycle_id, row.event_role, JSON.stringify(input.output), input.modelName.slice(0, 160), Math.max(0, Math.round(input.durationMs))]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failRuntimeExplanationJob(database: Pool, input: {
  jobId: string;
  workerId: string;
  fencingToken: number;
  code: string;
  message: string;
  retryAt: Date;
}) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{
      cycle_id: string;
      event_role: string;
      status: "retry_wait" | "failed";
    }>(`
      UPDATE strategy_runtime_explanation_jobs
      SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
          lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = $4,
          last_error_code = $5, last_error_message = $6, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND status = 'running'
      RETURNING cycle_id, event_role, status
    `, [input.jobId, input.workerId, input.fencingToken, input.retryAt, input.code.slice(0, 80), input.message.slice(0, 500)]);
    const row = updated.rows[0];
    if (!row) throw new Error("运行时解释 Worker 租约或 fencing token 已失效");
    await client.query(`
      UPDATE strategy_runtime_events
      SET explanation_status = $3, explanation_error_code = $4,
          explanation_updated_at = now()
      WHERE cycle_id = $1 AND role = $2
    `, [row.cycle_id, row.event_role, row.status, input.code.slice(0, 80)]);
    await client.query("COMMIT");
    return { status: row.status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failStrategyRuntimeLease(database: Queryable, input: {
  deploymentId: string;
  workerId: string;
  fencingToken: number;
  code: string;
  message: string;
  retryAt: Date;
}) {
  await database.query(`
    UPDATE strategy_deployments
    SET lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = $4, last_error_message = $5,
        next_cycle_at = $6, updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
  `, [input.deploymentId, input.workerId, input.fencingToken, input.code, input.message.slice(0, 500), input.retryAt]);
}

export async function deferStrategyRuntimeLease(database: Queryable, input: {
  deploymentId: string;
  workerId: string;
  fencingToken: number;
  nextCycleAt: Date;
}) {
  const result = await database.query(`
    UPDATE strategy_deployments
    SET lease_owner = NULL, lease_expires_at = NULL,
        next_cycle_at = $4, updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
  `, [input.deploymentId, input.workerId, input.fencingToken, input.nextCycleAt]);
  if (result.rowCount !== 1) throw new Error("Runtime Worker 租约或 fencing token 已失效");
}
