import type { Pool } from "pg";

import { ResearchApiError } from "./research-errors.ts";

export type MaintenanceTechnicalAuditEvent = {
  id: string;
  operation: "control" | "verify";
  actorUserId: string;
  account: { id: string; provider: string; label: string };
  action: string;
  strategyCode: string | null;
  reason: string;
  status: "pending" | "succeeded" | "failed";
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

function timestamp(value: unknown) {
  if (!value) return null;
  const date = new Date(value as string | Date);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_AUDIT_TIMESTAMP");
  return date.toISOString();
}
export function maintenanceTechnicalAuditDto(
  row: Record<string, unknown>,
): MaintenanceTechnicalAuditEvent {
  const operation = String(row.operation);
  const status = String(row.status);
  if (!['control', 'verify'].includes(operation)) throw new Error("UNKNOWN_AUDIT_OPERATION");
  if (!['pending', 'succeeded', 'failed'].includes(status)) throw new Error("UNKNOWN_AUDIT_STATUS");
  return {
    id: String(row.id),
    operation: operation as MaintenanceTechnicalAuditEvent["operation"],
    actorUserId: String(row.actor_user_id),
    account: {
      id: String(row.account_id),
      provider: String(row.provider),
      label: String(row.account_label),
    },
    action: String(row.action),
    strategyCode: row.strategy_code ? String(row.strategy_code) : null,
    reason: String(row.reason),
    status: status as MaintenanceTechnicalAuditEvent["status"],
    errorCode: row.error_code ? String(row.error_code) : null,
    createdAt: timestamp(row.created_at)!,
    completedAt: timestamp(row.completed_at),
  };
}

export async function loadMaintenanceTechnicalAudit(
  database: Pick<Pool, "query">,
  input: {
    limit: number;
    cursor: { createdAt: string; id: string } | null;
    operation: string | null;
    status: string | null;
  },
) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new ResearchApiError("VALIDATION_ERROR", "limit 无效", 422, { fields: ["limit"] });
  }
  if (input.operation && !["control", "verify"].includes(input.operation)) {
    throw new ResearchApiError("VALIDATION_ERROR", "operation 无效", 422, { fields: ["operation"] });
  }
  if (input.status && !["pending", "succeeded", "failed"].includes(input.status)) {
    throw new ResearchApiError("VALIDATION_ERROR", "status 无效", 422, { fields: ["status"] });
  }
  const values: unknown[] = [];
  const where: string[] = [];
  if (input.operation) {
    values.push(input.operation);
    where.push(`c.operation=$${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    where.push(`c.status=$${values.length}`);
  }
  if (input.cursor) {
    values.push(input.cursor.createdAt, input.cursor.id);
    where.push(`(c.created_at,c.id)<($${values.length - 1}::timestamptz,$${values.length})`);
  }
  values.push(input.limit + 1);
  const result = await database.query(
    `SELECT c.id,c.operation,c.actor_user_id,c.account_id,c.action,c.strategy_code,
            c.reason,c.status,c.error_code,c.created_at,c.completed_at,
            a.provider,a.label AS account_label
     FROM platform_demo_admin_commands c
     JOIN platform_demo_accounts_safe a ON a.id=c.account_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY c.created_at DESC,c.id DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(maintenanceTechnicalAuditDto);
}
