import type { Pool, PoolClient } from "pg";

import { canonicalPayloadHash } from "./commercial-idempotency.ts";
import { automaticAuditReason } from "./maintenance-audit.ts";
import { runMaintenanceIdempotentCommand } from "./maintenance-idempotency.ts";
import { ResearchApiError } from "./research-errors.ts";

export const MAX_EXPORT_ROWS = 1_000;

export type MaintenanceWorkRecordExportInput = {
  from: string;
  to: string;
};

type SafeExportRow = {
  workRecordRef: string;
  userRef: string;
  strategyCode: string;
  strategyVersion: string;
  symbol: string;
  timeframe: string;
  decisionStatus: string;
  completeness: string;
  executionMode: string;
  admissionStatus: string;
  orderIntentCount: number;
  fillReceiptCount: number;
  occurredAt: Date | string;
  isSharedDecision: boolean;
  realOrderRoutingEnabled: boolean;
};

type Queryable = Pick<PoolClient, "query">;

function utcDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function validation(message: string, fields: string[]): never {
  throw new ResearchApiError("VALIDATION_ERROR", message, 422, { fields });
}

export function parseMaintenanceWorkRecordExportInput(body: Record<string, unknown>): MaintenanceWorkRecordExportInput {
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "from" || keys[1] !== "to") {
    return validation("请求体只能包含 from 和 to", ["body"]);
  }
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const fromDate = utcDate(from);
  const toDate = utcDate(to);
  if (!fromDate || !toDate || fromDate > toDate) {
    return validation("导出日期必须是有效且顺序正确的 UTC 自然日", ["from", "to"]);
  }
  const inclusiveDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  if (inclusiveDays > 31) return validation("工作记录每次最多导出连续 31 个 UTC 自然日", ["from", "to"]);
  return { from, to };
}

export function maintenanceWorkRecordExportSafeText(value: unknown, maximum = 500) {
  const bounded = String(value ?? "").slice(0, maximum);
  return /^[=+\-@]/.test(bounded) ? `'${bounded}` : bounded;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function projectRow(row: SafeExportRow) {
  return {
    workRecordRef: maintenanceWorkRecordExportSafeText(row.workRecordRef, 32),
    userRef: maintenanceWorkRecordExportSafeText(row.userRef, 32),
    strategyCode: maintenanceWorkRecordExportSafeText(row.strategyCode, 80),
    strategyVersion: maintenanceWorkRecordExportSafeText(row.strategyVersion, 160),
    symbol: maintenanceWorkRecordExportSafeText(row.symbol, 40),
    timeframe: maintenanceWorkRecordExportSafeText(row.timeframe, 40),
    decisionStatus: maintenanceWorkRecordExportSafeText(row.decisionStatus, 80),
    completeness: maintenanceWorkRecordExportSafeText(row.completeness, 40),
    executionMode: maintenanceWorkRecordExportSafeText(row.executionMode, 20),
    admissionStatus: maintenanceWorkRecordExportSafeText(row.admissionStatus, 40),
    orderIntentCount: nonNegativeInteger(row.orderIntentCount),
    fillReceiptCount: nonNegativeInteger(row.fillReceiptCount),
    occurredAt: new Date(row.occurredAt).toISOString(),
    isSharedDecision: Boolean(row.isSharedDecision),
    realOrderRoutingEnabled: false as const,
  };
}

export async function buildMaintenanceWorkRecordExport(
  database: Queryable,
  input: MaintenanceWorkRecordExportInput,
  now = new Date(),
) {
  const result = await database.query<SafeExportRow>(`/* maintenance-work-record-export:safe-view */
    SELECT
      work_record_ref AS "workRecordRef",
      user_ref AS "userRef",
      strategy_code AS "strategyCode",
      strategy_version AS "strategyVersion",
      symbol,
      timeframe,
      decision_status AS "decisionStatus",
      completeness,
      execution_mode AS "executionMode",
      admission_status AS "admissionStatus",
      order_intent_count AS "orderIntentCount",
      fill_receipt_count AS "fillReceiptCount",
      occurred_at AS "occurredAt",
      is_shared_decision AS "isSharedDecision",
      real_order_routing_enabled AS "realOrderRoutingEnabled"
    FROM maintenance_strategy_work_records_safe
    WHERE occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
      AND occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
    ORDER BY occurred_at DESC,work_record_ref DESC
    LIMIT $3
  `, [input.from, input.to, MAX_EXPORT_ROWS + 1]);
  return {
    period: { from: input.from, to: input.to, timezone: "UTC" as const },
    generatedAt: now.toISOString(),
    limit: MAX_EXPORT_ROWS,
    truncated: result.rows.length > MAX_EXPORT_ROWS,
    data: result.rows.slice(0, MAX_EXPORT_ROWS).map(projectRow),
  };
}

export async function runMaintenanceWorkRecordExport(pool: Pool, input: MaintenanceWorkRecordExportInput & {
  actorUserId: string;
  idempotencyKey: string;
  requestId?: string | null;
  traceId?: string | null;
  now?: Date;
}) {
  const querySha256 = canonicalPayloadHash({ from: input.from, to: input.to });
  const reason = automaticAuditReason("maintenance.work_records.export");
  const now = input.now ?? new Date();
  return runMaintenanceIdempotentCommand(pool, {
    operation: "maintenance.work_records.export",
    actorUserId: input.actorUserId,
    subjectType: "strategy_work_record_export",
    subjectId: `query:${querySha256.slice(0, 24)}`,
    idempotencyKey: input.idempotencyKey,
    payload: { from: input.from, to: input.to, reason },
    requestId: input.requestId,
    traceId: input.traceId,
  }, async (client) => {
    await client.query("SET LOCAL statement_timeout='5s'");
    const response = await buildMaintenanceWorkRecordExport(client, input, now);
    await client.query(`
      INSERT INTO audit_logs(
        id,actor_user_id,action,subject_type,subject_id,after_json,
        request_id,trace_id,created_at
      ) VALUES($1,$2,'maintenance.work_records.export_generated',$3,$4,$5,$6,$7,$8)
    `, [
      crypto.randomUUID(),
      input.actorUserId,
      "strategy_work_record_export",
      `query:${querySha256.slice(0, 24)}`,
      JSON.stringify({
        from: input.from,
        to: input.to,
        rowCount: response.data.length,
        truncated: response.truncated,
        querySha256,
        reason,
        auditSource: "automatic",
      }),
      input.requestId ?? null,
      input.traceId ?? null,
      now.toISOString(),
    ]);
    return { terminalStatus: "succeeded", responseStatus: 200, response };
  });
}
