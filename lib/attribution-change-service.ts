import type { Pool, PoolClient } from "pg";

import { ResearchApiError } from "./research-errors.ts";

type AuthorizeCustomer = (client: PoolClient, customerId: string) => Promise<void>;

function requiredText(value: string, minimum: number, maximum: number, code: string, message: string) {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new ResearchApiError(code, message, 422);
  return normalized;
}

function effectiveDate(value: string, now: Date) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime() - 5 * 60_000 || parsed.getTime() > now.getTime() + 366 * 86_400_000) throw new ResearchApiError("ATTRIBUTION_EFFECTIVE_AT_INVALID", "生效时间必须在当前时间附近至未来一年内", 422);
  return parsed;
}

function requestNumber(now: Date) {
  return `AT-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function validateHierarchy(client: PoolClient, branchId: string, proposed: { managerId: string; supervisorId: string | null; employeeId: string | null }) {
  const ids = [proposed.managerId, proposed.supervisorId, proposed.employeeId].filter(Boolean) as string[];
  const result = await client.query<{ id: string; role: string; status: string; organization_id: string | null; reports_to_user_id: string | null }>(`
    SELECT id,role,status,organization_id,reports_to_user_id FROM users WHERE id=ANY($1::text[]) FOR SHARE
  `, [ids]);
  const members = new Map(result.rows.map((member) => [member.id, member]));
  const manager = members.get(proposed.managerId);
  if (!manager || manager.role !== "manager" || manager.status !== "active" || manager.organization_id !== branchId) throw new ResearchApiError("ATTRIBUTION_HIERARCHY_INVALID", "目标经理不属于当前组织或状态不可用", 422);
  if (proposed.supervisorId) {
    const supervisor = members.get(proposed.supervisorId);
    if (!supervisor || supervisor.role !== "supervisor" || supervisor.status !== "active" || supervisor.organization_id !== branchId || supervisor.reports_to_user_id !== manager.id) throw new ResearchApiError("ATTRIBUTION_HIERARCHY_INVALID", "目标主管不隶属于所选经理", 422);
  }
  if (proposed.employeeId) {
    const employee = members.get(proposed.employeeId);
    if (!proposed.supervisorId || !employee || employee.role !== "employee" || employee.status !== "active" || employee.organization_id !== branchId || employee.reports_to_user_id !== proposed.supervisorId) throw new ResearchApiError("ATTRIBUTION_HIERARCHY_INVALID", "目标员工必须隶属于所选主管", 422);
  }
}

export async function submitAttributionChange(pool: Pool, input: {
  actorUserId: string;
  customerId: string;
  managerId: string;
  supervisorId: string | null;
  employeeId: string | null;
  effectiveAt: string;
  reason: string;
  idempotencyKey: string;
  requestId: string;
  authorize: AuthorizeCustomer;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = requiredText(input.reason, 3, 500, "ATTRIBUTION_REASON_INVALID", "归属调整原因需要 3–500 个字符");
  const idempotencyKey = requiredText(input.idempotencyKey, 8, 160, "IDEMPOTENCY_KEY_INVALID", "幂等键需要 8–160 个字符");
  const at = effectiveDate(input.effectiveAt, now);
  const proposed = { managerId: input.managerId.trim(), supervisorId: input.supervisorId?.trim() || null, employeeId: input.employeeId?.trim() || null };
  if (!proposed.managerId) throw new ResearchApiError("ATTRIBUTION_MANAGER_REQUIRED", "必须选择目标经理", 422);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = (await client.query(`SELECT id,request_no,customer_id,proposed_assignment_json,effective_at,reason,status,requested_at FROM customer_attribution_change_requests WHERE requested_by_user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.actorUserId, idempotencyKey])).rows[0];
    if (replay) {
      if (replay.customer_id !== input.customerId || JSON.stringify(replay.proposed_assignment_json) !== JSON.stringify(proposed) || new Date(replay.effective_at).getTime() !== at.getTime() || replay.reason !== reason) throw new ResearchApiError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同的客户归属调整", 409);
      await client.query("COMMIT");
      return { id: replay.id, requestNo: replay.request_no, status: replay.status, requestedAt: new Date(replay.requested_at).toISOString(), replayed: true };
    }
    await input.authorize(client, input.customerId);
    const attribution = (await client.query(`
      SELECT id,customer_id,branch_id,manager_id,supervisor_id,employee_id,updated_at::text AS updated_at_text
        FROM customer_attributions WHERE customer_id=$1 AND status='active'
        ORDER BY effective_at DESC NULLS LAST,created_at DESC LIMIT 1 FOR UPDATE
    `, [input.customerId])).rows[0];
    if (!attribution?.branch_id) throw new ResearchApiError("ATTRIBUTION_NOT_FOUND", "客户没有可调整的有效组织归属", 409);
    await validateHierarchy(client, attribution.branch_id, proposed);
    if (attribution.manager_id === proposed.managerId && attribution.supervisor_id === proposed.supervisorId && attribution.employee_id === proposed.employeeId) throw new ResearchApiError("ATTRIBUTION_NO_CHANGE", "目标归属与当前归属相同", 409);
    const id = crypto.randomUUID();
    const previous = { managerId: attribution.manager_id, supervisorId: attribution.supervisor_id, employeeId: attribution.employee_id };
    try {
      await client.query(`
        INSERT INTO customer_attribution_change_requests(
          id,request_no,customer_id,attribution_id,branch_id,previous_assignment_json,proposed_assignment_json,
          expected_attribution_updated_at,effective_at,reason,status,requested_by_user_id,idempotency_key,request_id,requested_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,'pending',$11,$12,$13,$14,$14)
      `, [id, requestNumber(now), input.customerId, attribution.id, attribution.branch_id, JSON.stringify(previous), JSON.stringify(proposed), attribution.updated_at_text, at, reason, input.actorUserId, idempotencyKey, input.requestId, now]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ResearchApiError("ATTRIBUTION_CHANGE_PENDING", "该客户已有待复核的归属调整", 409);
      throw error;
    }
    await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at) VALUES($1,$2,'customer.attribution_change_requested','customer',$3,$4::jsonb,$5::jsonb,$6)`, [crypto.randomUUID(), input.actorUserId, input.customerId, JSON.stringify(previous), JSON.stringify({ proposed, effectiveAt: at.toISOString(), reason, requestId: input.requestId }), now]);
    await client.query("COMMIT");
    const created = (await pool.query("SELECT request_no FROM customer_attribution_change_requests WHERE id=$1", [id])).rows[0];
    return { id, requestNo: created.request_no, status: "pending", requestedAt: now.toISOString(), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function decideAttributionChange(pool: Pool, input: {
  actorUserId: string;
  changeId: string;
  decision: "approve" | "reject";
  note: string;
  idempotencyKey: string;
  requestId: string;
  authorize: AuthorizeCustomer;
  now?: Date;
}) {
  const note = requiredText(input.note, 3, 500, "ATTRIBUTION_DECISION_NOTE_INVALID", "复核说明需要 3–500 个字符");
  const idempotencyKey = requiredText(input.idempotencyKey, 8, 160, "IDEMPOTENCY_KEY_INVALID", "幂等键需要 8–160 个字符");
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = (await client.query(`SELECT decision.request_id,decision.reviewer_user_id,decision.decision,request.status FROM customer_attribution_change_decisions decision JOIN customer_attribution_change_requests request ON request.id=decision.request_id WHERE decision.idempotency_key=$1 FOR SHARE`, [idempotencyKey])).rows[0];
    if (replay) {
      if (replay.request_id !== input.changeId || replay.reviewer_user_id !== input.actorUserId || replay.decision !== input.decision) throw new ResearchApiError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同的客户归属复核", 409);
      await client.query("COMMIT");
      return { id: input.changeId, status: replay.status, replayed: true };
    }
    const change = (await client.query(`SELECT request.*,request.expected_attribution_updated_at::text AS expected_updated_at_text FROM customer_attribution_change_requests request WHERE id=$1 FOR UPDATE`, [input.changeId])).rows[0];
    if (!change) throw new ResearchApiError("ATTRIBUTION_CHANGE_NOT_FOUND", "客户归属调整不存在", 404);
    await input.authorize(client, change.customer_id);
    if (change.requested_by_user_id === input.actorUserId) throw new ResearchApiError("ATTRIBUTION_SELF_REVIEW", "申请人不能复核自己的客户归属调整", 403);
    if (change.status !== "pending") throw new ResearchApiError("ATTRIBUTION_CHANGE_STATE_CONFLICT", "客户归属调整已经处理", 409, { status: change.status });
    if (input.decision === "approve") {
      const proposed = change.proposed_assignment_json as { managerId: string; supervisorId: string | null; employeeId: string | null };
      await validateHierarchy(client, change.branch_id, proposed);
      const updated = await client.query(`
        UPDATE customer_attributions SET manager_id=$2,supervisor_id=$3,employee_id=$4,effective_at=$5,
               source='manual_transfer',reason=$6,approval_id=$7,updated_at=$8
         WHERE id=$1 AND updated_at=$9::timestamptz
         RETURNING id
      `, [change.attribution_id, proposed.managerId, proposed.supervisorId, proposed.employeeId, change.effective_at, change.reason, change.id, now, change.expected_updated_at_text]);
      if (!updated.rowCount) throw new ResearchApiError("ATTRIBUTION_SNAPSHOT_CHANGED", "客户归属已被其他流程修改，请重新提交申请", 409);
    }
    const status = input.decision === "approve" ? "approved" : "rejected";
    await client.query(`INSERT INTO customer_attribution_change_decisions(id,request_id,reviewer_user_id,decision,note,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [crypto.randomUUID(), change.id, input.actorUserId, input.decision, note, idempotencyKey, now]);
    await client.query(`UPDATE customer_attribution_change_requests SET status=$2,decided_by_user_id=$3,decision_note=$4,decided_at=$5,updated_at=$5 WHERE id=$1`, [change.id, status, input.actorUserId, note, now]);
    await client.query(`INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key) VALUES($1,$2,'in_app','account',$3,$4::jsonb,'queued',$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`, [crypto.randomUUID(), change.customer_id, `customer_attribution_${status}`, JSON.stringify({ requestId: change.id, status }), now, `attribution-change:${change.id}:${status}`]);
    await client.query(`INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at) VALUES($1,$2,$3,'customer',$4,$5::jsonb,$6::jsonb,$7)`, [crypto.randomUUID(), input.actorUserId, `customer.attribution_change_${status}`, change.customer_id, JSON.stringify(change.previous_assignment_json), JSON.stringify({ proposed: change.proposed_assignment_json, note, requestId: input.requestId }), now]);
    await client.query("COMMIT");
    return { id: change.id, status, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
