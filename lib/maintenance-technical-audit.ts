import type { Pool } from "pg";

import { ResearchApiError } from "./research-errors.ts";

export const maintenanceAuditDomains = ["demo", "models", "integrations", "settings", "safety", "identity"] as const;
export type MaintenanceAuditDomain = typeof maintenanceAuditDomains[number];

export type MaintenanceTechnicalAuditEvent = {
  id: string;
  domain: MaintenanceAuditDomain;
  action: string;
  actorUserId: string | null;
  subject: { type: string; id: string; label: string | null };
  reason: string | null;
  status: "pending" | "succeeded" | "failed";
  errorCode: string | null;
  requestId: string | null;
  traceId: string | null;
  createdAt: string;
  completedAt: string | null;
};

function timestamp(value: unknown) {
  if (!value) return null;
  const date = new Date(value as string | Date);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_AUDIT_TIMESTAMP");
  return date.toISOString();
}

export function maintenanceTechnicalAuditDto(row: Record<string, unknown>): MaintenanceTechnicalAuditEvent {
  const domain = String(row.domain);
  const status = String(row.status);
  const action = String(row.action);
  if (!maintenanceAuditDomains.includes(domain as MaintenanceAuditDomain)) throw new Error("UNKNOWN_AUDIT_DOMAIN");
  if (!["pending", "succeeded", "failed"].includes(status)) throw new Error("UNKNOWN_AUDIT_STATUS");
  if (!/^[a-z0-9_.:-]{1,120}$/.test(action)) throw new Error("UNKNOWN_AUDIT_ACTION");
  return {
    id: String(row.id),
    domain: domain as MaintenanceAuditDomain,
    action,
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    subject: {
      type: String(row.subject_type),
      id: String(row.subject_id),
      label: row.subject_label ? String(row.subject_label) : null,
    },
    reason: row.reason ? String(row.reason).slice(0, 500) : null,
    status: status as MaintenanceTechnicalAuditEvent["status"],
    errorCode: row.error_code ? String(row.error_code).slice(0, 120) : null,
    requestId: row.request_id ? String(row.request_id).slice(0, 120) : null,
    traceId: row.trace_id ? String(row.trace_id).slice(0, 120) : null,
    createdAt: timestamp(row.created_at)!,
    completedAt: timestamp(row.completed_at),
  };
}

export async function loadMaintenanceTechnicalAudit(database: Pick<Pool, "query">, input: {
  limit: number;
  cursor: { createdAt: string; id: string } | null;
  domain?: string | null;
  action?: string | null;
  operation?: string | null;
  status: string | null;
}) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new ResearchApiError("VALIDATION_ERROR", "limit 无效", 422, { fields: ["limit"] });
  }
  if (input.domain && !maintenanceAuditDomains.includes(input.domain as MaintenanceAuditDomain)) {
    throw new ResearchApiError("VALIDATION_ERROR", "domain 无效", 422, { fields: ["domain"] });
  }
  if (input.operation && !["control", "verify"].includes(input.operation)) {
    throw new ResearchApiError("VALIDATION_ERROR", "operation 无效", 422, { fields: ["operation"] });
  }
  if (input.action && !/^[a-z0-9_.:-]{1,120}$/.test(input.action)) {
    throw new ResearchApiError("VALIDATION_ERROR", "action 无效", 422, { fields: ["action"] });
  }
  if (input.status && !["pending", "succeeded", "failed"].includes(input.status)) {
    throw new ResearchApiError("VALIDATION_ERROR", "status 无效", 422, { fields: ["status"] });
  }
  const values: unknown[] = [];
  const where: string[] = [];
  if (input.domain) { values.push(input.domain); where.push(`event.domain=$${values.length}`); }
  if (input.operation) { values.push(`demo.${input.operation}.%`); where.push(`event.action LIKE $${values.length}`); }
  if (input.action) { values.push(input.action); where.push(`event.action=$${values.length}`); }
  if (input.status) { values.push(input.status); where.push(`event.status=$${values.length}`); }
  if (input.cursor) {
    values.push(input.cursor.createdAt, input.cursor.id);
    where.push(`(event.created_at,event.id)<($${values.length - 1}::timestamptz,$${values.length})`);
  }
  values.push(input.limit + 1);
  const result = await database.query(`
    WITH event AS (
      SELECT 'demo:'||command.id AS id,'demo'::text AS domain,
             'demo.'||command.operation||'.'||command.action AS action,
             command.actor_user_id,command.account_id AS subject_id,
             'platform_demo_account'::text AS subject_type,
             account.provider||' · '||account.label AS subject_label,
             command.reason,command.status,command.error_code,
             command.request_id,command.trace_id,
             command.created_at,command.completed_at
        FROM platform_demo_admin_commands command
        JOIN platform_demo_accounts_safe account ON account.id=command.account_id
      UNION ALL
      SELECT 'audit:'||audit.id,
             CASE
               WHEN audit.action LIKE 'maintenance.llm_%' OR audit.action LIKE 'maintenance.%binding%' THEN 'models'
               WHEN audit.action LIKE 'maintenance.%' OR audit.action LIKE 'payment_provider.%' THEN 'integrations'
               WHEN audit.action LIKE 'platform.settings.%' OR audit.action LIKE 'commercial.disclosure.%' THEN 'settings'
               WHEN audit.action LIKE 'trading.emergency_stop.%' THEN 'safety'
               ELSE 'identity'
             END,
             audit.action,audit.actor_user_id,audit.subject_id,audit.subject_type,
             NULL::text,
             CASE
               WHEN audit.action IN (
                 'maintenance.integration_test',
                 'maintenance.email_test_recorded',
                 'maintenance.payment_test_recorded',
                 'maintenance.llm_profile_rolled_back'
               ) OR audit.action LIKE 'trading.emergency_stop.%'
                 THEN NULLIF(audit.after_json::jsonb->>'reason','')
               WHEN audit.action='platform.settings.system.updated'
                 THEN NULLIF(audit.after_json::jsonb->>'maintenanceReason','')
               ELSE NULL::text
             END,
             CASE
               WHEN audit.error_code IS NOT NULL
                 OR audit.after_json::jsonb->>'status'='failed' THEN 'failed'
               ELSE 'succeeded'
             END,
             audit.error_code,
             audit.request_id,audit.trace_id,
             audit.created_at::timestamptz,audit.created_at::timestamptz
        FROM audit_logs audit
       WHERE audit.action LIKE 'maintenance.%'
          OR audit.action LIKE 'payment_provider.%'
          OR audit.action LIKE 'platform.settings.%'
          OR audit.action LIKE 'commercial.disclosure.%'
          OR audit.action LIKE 'trading.emergency_stop.%'
          OR audit.action LIKE 'auth.mfa_%'
    )
    SELECT event.id,event.domain,event.action,event.actor_user_id,event.subject_id,
           event.subject_type,event.subject_label,event.reason,event.status,
           event.error_code,event.request_id,event.trace_id,
           event.created_at,event.completed_at
      FROM event
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY event.created_at DESC,event.id DESC
     LIMIT $${values.length}
  `, values);
  return result.rows.map(maintenanceTechnicalAuditDto);
}
