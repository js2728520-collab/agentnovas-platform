import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  MaintenanceWorkRecordExportRequest,
  MaintenanceWorkRecordExportResult,
  MaintenanceWorkRecordExportRow,
} from "@/packages/contracts/src/strategy-work-records";
import { ResearchApiError } from "./research-errors.ts";

// 规格 §5：日期两端包含、最多 31 天、最多 1,000 条。
// 上限是产品合同而不是性能调参，因此写死在这里而不是做成配置。
export const MAINTENANCE_WORK_RECORD_EXPORT_MAX_DAYS = 31;
export const MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS = 1_000;
const REASON_MIN = 3;
const REASON_MAX = 500;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseUtcDay(value: unknown, field: "from" | "to") {
  if (typeof value !== "string" || !datePattern.test(value)) {
    throw new ResearchApiError("VALIDATION_ERROR", "日期必须是 YYYY-MM-DD", 422, { fields: [field] });
  }
  // 显式按 UTC 解析。用 new Date("2026-08-24") 也是 UTC，但同一段代码里若有人
  // 改成 "YYYY-MM-DD HH:mm" 就会静默变成本地时区，导出边界随部署机器漂移。
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    throw new ResearchApiError("VALIDATION_ERROR", "日期不是有效的 UTC 日期", 422, { fields: [field] });
  }
  const date = new Date(timestamp);
  if (date.toISOString().slice(0, 10) !== value) {
    // 2026-02-30 会被 Date.parse 归一到 3 月，静默改变导出范围。
    throw new ResearchApiError("VALIDATION_ERROR", "日期不存在", 422, { fields: [field] });
  }
  return date;
}

export function parseMaintenanceWorkRecordExportRequest(body: unknown): MaintenanceWorkRecordExportRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ResearchApiError("VALIDATION_ERROR", "请求体必须是对象", 422);
  }
  const source = body as Record<string, unknown>;
  // 严格 body：多余字段一律拒绝，避免以后有人靠隐藏参数扩大导出范围。
  const unknownKeys = Object.keys(source).filter((key) => !["from", "to", "reason"].includes(key));
  if (unknownKeys.length) {
    throw new ResearchApiError("VALIDATION_ERROR", "请求体只允许 from、to 和 reason", 422, { fields: unknownKeys });
  }

  const from = parseUtcDay(source.from, "from");
  const to = parseUtcDay(source.to, "to");
  if (to.getTime() < from.getTime()) {
    throw new ResearchApiError("VALIDATION_ERROR", "结束日期不能早于开始日期", 422, { fields: ["from", "to"] });
  }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > MAINTENANCE_WORK_RECORD_EXPORT_MAX_DAYS) {
    throw new ResearchApiError(
      "VALIDATION_ERROR",
      `导出区间最多 ${MAINTENANCE_WORK_RECORD_EXPORT_MAX_DAYS} 天`,
      422,
      { fields: ["from", "to"] },
    );
  }

  const reason = typeof source.reason === "string" ? source.reason.trim() : "";
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    throw new ResearchApiError(
      "VALIDATION_ERROR",
      `导出原因必须是 ${REASON_MIN}–${REASON_MAX} 个字符`,
      422,
      { fields: ["reason"] },
    );
  }

  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), reason, days };
}

/** 审计只记录查询摘要，不记录导出正文——正文里有逐条客户决策记录。 */
export function maintenanceWorkRecordExportQueryHash(input: { from: string; to: string }) {
  return createHash("sha256").update(`${input.from}|${input.to}`).digest("hex");
}

type ExportRow = {
  record_id: string;
  is_shared_decision: boolean;
  occurred_at: Date | string;
  candle_open_at: Date | string;
  strategy_code: string;
  strategy_version_id: string;
  symbol: string;
  timeframe: string;
  decision_status: string;
  completeness: string;
  execution_mode: string;
  admission_status: string;
  customer_pseudonym: string;
  market_source: string | null;
  candle_count: number | null;
  data_start: Date | string | null;
  data_end: Date | string | null;
  order_intent_count: string | number;
  fill_receipt_count: string | number;
  trace_id: string | null;
};

function iso(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function exportRowView(row: ExportRow): MaintenanceWorkRecordExportRow {
  return {
    recordId: row.record_id,
    isSharedDecision: row.is_shared_decision,
    occurredAt: iso(row.occurred_at) as string,
    candleOpenAt: iso(row.candle_open_at) as string,
    strategyCode: row.strategy_code,
    strategyVersionId: row.strategy_version_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    decisionStatus: row.decision_status,
    completeness: row.completeness,
    executionMode: row.execution_mode,
    admissionStatus: row.admission_status,
    customerPseudonym: row.customer_pseudonym,
    marketSource: row.market_source,
    candleCount: row.candle_count === null ? null : Number(row.candle_count),
    dataStart: iso(row.data_start),
    dataEnd: iso(row.data_end),
    orderIntentCount: Number(row.order_intent_count),
    fillReceiptCount: Number(row.fill_receipt_count),
    traceId: row.trace_id,
  };
}

/**
 * 只读取 security-barrier 安全视图。这里刻意不 join 任何业务原表：
 * 一旦为了「多带一个字段」而 join 回去，运维端就重新获得了原表读权限，
 * 视图这层边界也就名存实亡。
 */
export async function exportMaintenanceWorkRecords(
  database: Pool | PoolClient,
  input: { from: string; to: string },
): Promise<MaintenanceWorkRecordExportResult> {
  // 多取一条用来判断是否被截断。返回 1,001 条时说明区间内还有更多，
  // truncated=true 如实告诉调用方这不是完整结果（INV-6）。
  const result = await database.query<ExportRow>(`
    SELECT record_id, is_shared_decision, occurred_at, candle_open_at,
           strategy_code, strategy_version_id, symbol, timeframe,
           decision_status, completeness, execution_mode, admission_status,
           customer_pseudonym, market_source, candle_count, data_start, data_end,
           order_intent_count, fill_receipt_count, trace_id
      FROM maintenance_strategy_work_records_safe
     WHERE occurred_day >= $1::date AND occurred_day <= $2::date
     ORDER BY occurred_at DESC, record_id DESC
     LIMIT $3
  `, [input.from, input.to, MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS + 1]);

  const truncated = result.rows.length > MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS;
  const rows = truncated
    ? result.rows.slice(0, MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS)
    : result.rows;

  return {
    from: input.from,
    to: input.to,
    rowCount: rows.length,
    truncated,
    maxRows: MAINTENANCE_WORK_RECORD_EXPORT_MAX_ROWS,
    realOrderRoutingEnabled: false,
    rows: rows.map(exportRowView),
  };
}
