import type { Pool } from "pg";

import { ResearchApiError } from "./research-errors.ts";
import {
  officialTradingHallStrategies,
  tradingHallAgentCatalog,
  tradingHallAgentKeyForRuntimeRole,
  type TradingHallAgentKey,
  type TradingHallRoundCompleteness,
} from "../packages/contracts/src/trading-hall.ts";
import type {
  StrategyWorkRecordAdmission,
  StrategyWorkRecordAdmissionStatus,
  StrategyWorkRecordDetail,
  StrategyWorkRecordEvent,
  StrategyWorkRecordFillReceipt,
  StrategyWorkRecordMarketSnapshot,
  StrategyWorkRecordOrderIntent,
  StrategyWorkRecordSummary,
} from "../packages/contracts/src/strategy-work-records.ts";

export type StrategyWorkRecordCursor = { occurredAt: string; id: string };

type RuntimeEventSource = {
  sequence: number;
  role: string;
  conclusion: string;
  evidence_json: Record<string, unknown>;
  llm_used: boolean;
  explanation_status: string;
  explanation_json: { summary?: string } | null;
  created_at: Date | string;
};

type SummaryRow = {
  record_id: string;
  strategy_code: StrategyWorkRecordSummary["strategyCode"];
  strategy_version_id: string;
  symbol: string;
  timeframe: string;
  decision_status: string;
  completeness: TradingHallRoundCompleteness;
  execution_mode: "shadow" | "paper";
  admission_status: StrategyWorkRecordAdmissionStatus;
  has_order_intent: boolean;
  has_fill_receipt: boolean;
  occurred_at: Date | string;
  is_shared_decision: boolean;
};

type DetailRow = SummaryRow & {
  candle_open_at: Date | string;
  trace_id: string | null;
  shared_decision_round_id: string | null;
  market_data_snapshot_id: string | null;
  customer_cycle_id: string | null;
  customer_cycle_status: string | null;
  customer_decision_json: Record<string, unknown> | null;
  customer_cycle_completed_at: Date | string | null;
};

const recordIdPattern = /^[A-Za-z0-9:._-]{1,128}$/;

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function workRecordId(value: unknown) {
  const id = String(value ?? "").trim();
  if (!recordIdPattern.test(id)) {
    throw new ResearchApiError("WORK_RECORD_NOT_FOUND", "工作记录不存在", 404);
  }
  return id;
}

export function encodeStrategyWorkRecordCursor(cursor: StrategyWorkRecordCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeStrategyWorkRecordCursor(value: string | null) {
  if (!value) return null;
  try {
    if (value.length > 512) throw new Error("cursor too long");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<StrategyWorkRecordCursor>;
    if (!parsed.occurredAt || Number.isNaN(Date.parse(parsed.occurredAt)) || !recordIdPattern.test(parsed.id ?? "")) {
      throw new Error("invalid cursor");
    }
    return { occurredAt: new Date(parsed.occurredAt).toISOString(), id: parsed.id! };
  } catch {
    throw new ResearchApiError("VALIDATION_ERROR", "工作记录游标无效", 422, { fields: ["cursor"] });
  }
}

export function parseStrategyWorkRecordListInput(url: URL) {
  const rawLimit = url.searchParams.get("limit") ?? "20";
  if (!/^\d{1,2}$/.test(rawLimit)) {
    throw new ResearchApiError("VALIDATION_ERROR", "工作记录分页数量无效", 422, { fields: ["limit"] });
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ResearchApiError("VALIDATION_ERROR", "工作记录分页数量必须为 1–50", 422, { fields: ["limit"] });
  }
  return { limit, cursor: decodeStrategyWorkRecordCursor(url.searchParams.get("cursor")) };
}

function publicScalar(value: unknown) {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pick(source: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = publicScalar(source[key]);
    return value === undefined ? [] : [[key, value]];
  }));
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 500))
    : [];
}

function publicEvidence(role: string, evidence: Record<string, unknown>) {
  switch (role) {
    case "market_data":
      return pick(evidence, ["valid", "candleCount", "gapsOrDuplicates", "marketState", "sampleSize", "returnPct", "averageRangePct", "candleCloseTime"]);
    case "technical_analysis":
      return pick(evidence, ["longEntry", "shortEntry", "dslExit", "close"]);
    case "strategy_decision":
      return pick(evidence, ["action", "reason", "strategyVersionId"]);
    case "adversarial_review":
      return { objections: stringList(evidence.objections) };
    case "risk":
      return {
        riskState: pick(asRecord(evidence.riskState), ["drawdownPct", "dailyLossPct", "consecutiveLosses", "halted"]),
        rejectionReasons: stringList(evidence.rejectionReasons),
      };
    case "decision":
      return { ...pick(evidence, ["action", "reason", "riskApproved"]), rejectionReasons: stringList(evidence.rejectionReasons) };
    case "execution": {
      const intent = asRecord(evidence.orderIntent);
      return {
        executionMode: publicScalar(evidence.executionMode),
        orderIntent: Object.keys(intent).length ? pick(intent, ["mode", "action", "side", "executionTiming", "requestedPrice", "confirmedAtCandleCloseTime"]) : null,
      };
    }
    case "audit":
      return { legacy: true };
    default:
      return {};
  }
}

export function strategyWorkRecordEventView(event: RuntimeEventSource): StrategyWorkRecordEvent | null {
  const productRole = tradingHallAgentKeyForRuntimeRole(event.role);
  if (!productRole && event.role !== "audit") return null;
  const catalog = productRole
    ? tradingHallAgentCatalog.find((agent) => agent.key === productRole)
    : null;
  return {
    sequence: event.sequence,
    role: (productRole || "legacy_audit") as TradingHallAgentKey | "legacy_audit",
    name: catalog?.name || "系统审计（历史）",
    outputName: catalog?.outputName || "旧周期审计记录",
    conclusion: event.conclusion.slice(0, 2_000),
    evidence: publicEvidence(event.role, asRecord(event.evidence_json)),
    llmUsed: event.llm_used,
    explanationStatus: event.explanation_status.slice(0, 100),
    explanation: typeof event.explanation_json?.summary === "string"
      ? event.explanation_json.summary.slice(0, 2_000)
      : null,
    createdAt: iso(event.created_at),
  };
}

function admissionDecision(value: Record<string, unknown> | null) {
  if (!value) return null;
  return {
    ...pick(value, ["action", "reason", "riskApproved"]),
    rejectionReasons: stringList(value.rejectionReasons),
    riskState: pick(asRecord(value.riskState), ["drawdownPct", "dailyLossPct", "consecutiveLosses", "halted"]),
  };
}

function strategyName(code: StrategyWorkRecordSummary["strategyCode"]) {
  return officialTradingHallStrategies.find((strategy) => strategy.code === code)?.name ?? code;
}

function summaryView(row: SummaryRow): StrategyWorkRecordSummary {
  return {
    recordId: row.record_id,
    strategyCode: row.strategy_code,
    strategyName: strategyName(row.strategy_code),
    strategyVersion: row.strategy_version_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    decisionStatus: row.decision_status,
    completeness: row.completeness,
    executionMode: row.execution_mode,
    admissionStatus: row.admission_status,
    hasOrderIntent: row.has_order_intent,
    hasFillReceipt: row.has_fill_receipt,
    occurredAt: iso(row.occurred_at),
    isSharedDecision: row.is_shared_decision,
  };
}

const eligibleRecordsCte = `
  WITH shared_records AS (
    SELECT DISTINCT ON (round.id)
      round.id AS record_id, round.strategy_code, round.strategy_version_id,
      round.symbol, round.timeframe,
      COALESCE(round.decision_json->>'action', 'monitoring') AS decision_status,
      round.completeness, period.mode AS execution_mode,
      CASE
        WHEN cycle.id IS NULL AND COALESCE(round.decision_json->>'action', 'hold') = 'hold' THEN 'not_required'
        WHEN cycle.id IS NULL THEN 'not_recorded'
        WHEN cycle.status = 'failed' THEN 'failed'
        WHEN cycle.decision_json->>'riskApproved' = 'false' THEN 'risk_rejected'
        ELSE 'recorded'
      END AS admission_status,
      EXISTS (SELECT 1 FROM official_paper_order_intents intent WHERE intent.runtime_cycle_id = cycle.id) AS has_order_intent,
      EXISTS (
        SELECT 1 FROM official_paper_fill_receipts receipt
        JOIN official_paper_order_intents intent ON intent.id = receipt.intent_id
        WHERE intent.runtime_cycle_id = cycle.id
      ) AS has_fill_receipt,
      round.candle_close_time AS occurred_at, true AS is_shared_decision,
      round.candle_open_time AS candle_open_at, round.trace_id,
      round.id AS shared_decision_round_id, round.market_data_snapshot_id,
      cycle.id AS customer_cycle_id, cycle.status AS customer_cycle_status,
      cycle.decision_json AS customer_decision_json,
      cycle.completed_at AS customer_cycle_completed_at
    FROM strategy_subscription_periods AS period
    JOIN strategy_deployments AS deployment
      ON deployment.id = period.deployment_id AND deployment.owner_user_id = $1
    JOIN strategy_decision_rounds AS round
      ON round.strategy_code = period.strategy_code AND round.symbol = period.symbol
     AND round.strategy_version_id = period.strategy_version_id
     AND round.candle_close_time >= period.started_at
     AND (period.ended_at IS NULL OR round.candle_close_time <= period.ended_at)
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM strategy_runtime_cycles AS candidate
      WHERE candidate.deployment_id = period.deployment_id
        AND candidate.decision_round_id = round.id
      ORDER BY candidate.completed_at DESC, candidate.id DESC LIMIT 1
    ) AS cycle ON true
    WHERE period.customer_id = $1
    ORDER BY round.id, period.started_at DESC, period.id DESC
  ), legacy_records AS (
    SELECT
      cycle.id AS record_id, period.strategy_code, period.strategy_version_id,
      period.symbol, mapping_timeframe.timeframe,
      COALESCE(cycle.decision_json->>'action', 'monitoring') AS decision_status,
      'legacy'::text AS completeness, period.mode AS execution_mode,
      CASE
        WHEN cycle.status = 'failed' THEN 'failed'
        WHEN cycle.decision_json->>'riskApproved' = 'false' THEN 'risk_rejected'
        ELSE 'recorded'
      END AS admission_status,
      EXISTS (SELECT 1 FROM official_paper_order_intents intent WHERE intent.runtime_cycle_id = cycle.id) AS has_order_intent,
      EXISTS (
        SELECT 1 FROM official_paper_fill_receipts receipt
        JOIN official_paper_order_intents intent ON intent.id = receipt.intent_id
        WHERE intent.runtime_cycle_id = cycle.id
      ) AS has_fill_receipt,
      cycle.candle_close_time AS occurred_at, false AS is_shared_decision,
      cycle.candle_open_time AS candle_open_at, cycle.trace_id,
      NULL::text AS shared_decision_round_id, cycle.market_data_snapshot_id,
      cycle.id AS customer_cycle_id, cycle.status AS customer_cycle_status,
      cycle.decision_json AS customer_decision_json,
      cycle.completed_at AS customer_cycle_completed_at
    FROM strategy_subscription_periods AS period
    JOIN strategy_deployments AS deployment
      ON deployment.id = period.deployment_id AND deployment.owner_user_id = $1
    JOIN strategy_runtime_cycles AS cycle
      ON cycle.deployment_id = period.deployment_id AND cycle.decision_round_id IS NULL
     AND cycle.candle_close_time >= period.started_at
     AND (period.ended_at IS NULL OR cycle.candle_close_time <= period.ended_at)
    CROSS JOIN LATERAL (
      SELECT COALESCE(NULLIF(cycle.decision_json->>'timeframe', ''), '1h') AS timeframe
    ) AS mapping_timeframe
    WHERE period.customer_id = $1
  ), eligible_records AS (
    SELECT * FROM shared_records
    UNION ALL
    SELECT * FROM legacy_records
  )
`;

export async function listClientStrategyWorkRecords(pool: Pick<Pool, "connect">, input: {
  userId: string;
  limit: number;
  cursor: StrategyWorkRecordCursor | null;
}) {
  const values: unknown[] = [input.userId];
  let cursorClause = "";
  if (input.cursor) {
    values.push(input.cursor.occurredAt, input.cursor.id);
    cursorClause = "WHERE (occurred_at, record_id) < ($2::timestamptz, $3)";
  }
  values.push(input.limit + 1);
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='5s'");
    const result = await client.query<SummaryRow>(`
      ${eligibleRecordsCte}
      SELECT record_id,strategy_code,strategy_version_id,symbol,timeframe,decision_status,
        completeness,execution_mode,admission_status,has_order_intent,has_fill_receipt,
        occurred_at,is_shared_decision
      FROM eligible_records
      ${cursorClause}
      ORDER BY occurred_at DESC, record_id DESC
      LIMIT $${values.length}
    `, values);
    await client.query("COMMIT");
    const visible = result.rows.slice(0, input.limit);
    const last = visible.at(-1);
    return {
      data: visible.map(summaryView),
      nextCursor: result.rows.length > input.limit && last
        ? encodeStrategyWorkRecordCursor({ occurredAt: iso(last.occurred_at), id: last.record_id })
        : null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadClientStrategyWorkRecord(pool: Pick<Pool, "connect">, input: {
  userId: string;
  recordId: string;
}): Promise<StrategyWorkRecordDetail> {
  const recordId = workRecordId(input.recordId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='5s'");
    const row = (await client.query<DetailRow>(`
      ${eligibleRecordsCte}
      SELECT * FROM eligible_records WHERE record_id = $2 LIMIT 1
    `, [input.userId, recordId])).rows[0];
    if (!row) throw new ResearchApiError("WORK_RECORD_NOT_FOUND", "工作记录不存在", 404);

    const events = await client.query<RuntimeEventSource>(`
      SELECT sequence,role,conclusion,evidence_json,llm_used,
        explanation_status,explanation_json,created_at
      FROM strategy_runtime_events
      WHERE ($1::text IS NOT NULL AND decision_round_id = $1)
         OR ($1::text IS NULL AND cycle_id = $2)
      ORDER BY sequence,created_at,id
    `, [row.shared_decision_round_id, row.customer_cycle_id]);

    const snapshot = row.market_data_snapshot_id ? (await client.query<{
      exchange: string; symbol: string; timeframe: string; data_start: Date; data_end: Date;
      candle_count: number; dataset_sha256: string; data_quality_json: Record<string, unknown>;
    }>(`
      SELECT exchange,symbol,timeframe,data_start,data_end,candle_count,dataset_sha256,data_quality_json
      FROM market_data_snapshots WHERE id = $1 LIMIT 1
    `, [row.market_data_snapshot_id])).rows[0] : null;

    const intents = row.customer_cycle_id ? await client.query<{
      id: string; action: "buy" | "sell"; execution_timing: string; requested_price: string | null;
      status: string; rejection_code: string | null; created_at: Date; filled_at: Date | null;
    }>(`
      SELECT id,action,execution_timing,requested_price::text,status,rejection_code,created_at,filled_at
      FROM official_paper_order_intents
      WHERE runtime_cycle_id = $1
      ORDER BY created_at,id
    `, [row.customer_cycle_id]) : { rows: [] };

    const fills = row.customer_cycle_id ? await client.query<{
      id: string; intent_id: string; action: "buy" | "sell"; quantity: string; fill_price: string;
      notional_usdt: string; fee_usdt: string; realized_gross_pnl_usdt: string;
      realized_net_pnl_usdt: string; filled_at: Date;
    }>(`
      SELECT receipt.id,receipt.intent_id,receipt.action,receipt.quantity::text,
        receipt.fill_price::text,receipt.notional_usdt::text,receipt.fee_usdt::text,
        receipt.realized_gross_pnl_usdt::text,receipt.realized_net_pnl_usdt::text,
        receipt.filled_at
      FROM official_paper_fill_receipts AS receipt
      JOIN official_paper_order_intents AS intent ON intent.id = receipt.intent_id
      WHERE intent.runtime_cycle_id = $1
      ORDER BY receipt.filled_at,receipt.id
    `, [row.customer_cycle_id]) : { rows: [] };

    await client.query("COMMIT");
    const marketSnapshot: StrategyWorkRecordMarketSnapshot | null = snapshot ? {
      exchange: snapshot.exchange,
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      dataStart: iso(snapshot.data_start),
      dataEnd: iso(snapshot.data_end),
      candleCount: snapshot.candle_count,
      datasetSha256: snapshot.dataset_sha256,
      dataQuality: pick(asRecord(snapshot.data_quality_json), ["valid", "gapsOrDuplicates", "stale", "latencyMs", "sourceStatus"]),
    } : null;
    const admission: StrategyWorkRecordAdmission = {
      status: row.admission_status,
      cycleId: row.customer_cycle_id,
      cycleStatus: row.customer_cycle_status,
      decision: admissionDecision(row.customer_decision_json),
      completedAt: row.customer_cycle_completed_at ? iso(row.customer_cycle_completed_at) : null,
    };
    const orderIntents: StrategyWorkRecordOrderIntent[] = intents.rows.map((intent) => ({
      id: intent.id,
      action: intent.action,
      executionTiming: intent.execution_timing,
      requestedPrice: intent.requested_price,
      status: intent.status,
      rejectionCode: intent.rejection_code,
      createdAt: iso(intent.created_at),
      filledAt: intent.filled_at ? iso(intent.filled_at) : null,
    }));
    const fillReceipts: StrategyWorkRecordFillReceipt[] = fills.rows.map((fill) => ({
      id: fill.id,
      intentId: fill.intent_id,
      action: fill.action,
      quantity: fill.quantity,
      fillPrice: fill.fill_price,
      notionalUsdt: fill.notional_usdt,
      feeUsdt: fill.fee_usdt,
      realizedGrossPnlUsdt: fill.realized_gross_pnl_usdt,
      realizedNetPnlUsdt: fill.realized_net_pnl_usdt,
      filledAt: iso(fill.filled_at),
    }));
    return {
      ...summaryView(row),
      candleOpenAt: iso(row.candle_open_at),
      traceId: row.trace_id?.slice(0, 128) ?? null,
      sharedDecisionRoundId: row.shared_decision_round_id,
      marketSnapshot,
      events: events.rows.flatMap((event) => {
        const projected = strategyWorkRecordEventView(event);
        return projected ? [projected] : [];
      }),
      admission,
      orderIntents,
      fillReceipts,
      realOrderRoutingEnabled: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
