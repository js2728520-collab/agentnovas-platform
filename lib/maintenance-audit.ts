import type { Pool } from "pg";

import { ResearchApiError } from "./research-errors.ts";

export function maintenanceReason(value: unknown) {
  const reason = String(value ?? "").trim().slice(0, 500);
  if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写运维变更原因", 422, { fields: ["reason"] });
  return reason;
}

function safeCorrelationId(value: string | null) {
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{1,120}$/.test(normalized) ? normalized : null;
}

export function maintenanceCorrelation(request: Request) {
  return {
    requestId: safeCorrelationId(request.headers.get("x-request-id")),
    traceId: safeCorrelationId(request.headers.get("x-trace-id")),
  };
}

export async function recordMaintenanceAudit(pool: Pick<Pool, "query">, input: {
  actorUserId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  reason: string;
  requestId?: string | null;
  traceId?: string | null;
  errorCode?: string | null;
}) {
  await pool.query(`
    INSERT INTO audit_logs (
      id, actor_user_id, action, subject_type, subject_id, after_json,
      request_id, trace_id, error_code
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    crypto.randomUUID(), input.actorUserId, input.action, input.subjectType,
    input.subjectId, JSON.stringify({ reason: input.reason }),
    input.requestId ?? null, input.traceId ?? null, input.errorCode ?? null,
  ]);
}
