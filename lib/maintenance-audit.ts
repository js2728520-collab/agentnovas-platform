import type { Pool } from "pg";

import { ResearchApiError } from "./research-errors.ts";

export function automaticAuditReason(action: string) {
  const normalized = action.trim();
  if (!/^[a-z][a-z0-9_]*(?:[.:][a-z][a-z0-9_]*){1,11}$/.test(normalized) || normalized.length > 180) {
    throw new ResearchApiError("AUTOMATIC_AUDIT_ACTION_INVALID", "自动审计动作无效", 500);
  }
  return `automatic:${normalized}`;
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
  requestId?: string | null;
  traceId?: string | null;
  errorCode?: string | null;
}) {
  const reason = automaticAuditReason(input.action);
  await pool.query(`
    INSERT INTO audit_logs (
      id, actor_user_id, action, subject_type, subject_id, after_json,
      request_id, trace_id, error_code
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    crypto.randomUUID(), input.actorUserId, input.action, input.subjectType,
    input.subjectId, JSON.stringify({
      reason,
      auditSource: "automatic",
      action: input.action,
    }),
    input.requestId ?? null, input.traceId ?? null, input.errorCode ?? null,
  ]);
}
