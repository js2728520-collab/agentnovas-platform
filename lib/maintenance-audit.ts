import type { Pool } from "pg";

import { ResearchApiError } from "./research-errors.ts";

export function maintenanceReason(value: unknown) {
  const reason = String(value ?? "").trim().slice(0, 500);
  if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写运维变更原因", 422, { fields: ["reason"] });
  return reason;
}

export async function recordMaintenanceAudit(pool: Pool, input: { actorUserId: string; action: string; subjectType: string; subjectId: string; reason: string }) {
  await pool.query(`
    INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [crypto.randomUUID(), input.actorUserId, input.action, input.subjectType, input.subjectId, JSON.stringify({ reason: input.reason })]);
}
