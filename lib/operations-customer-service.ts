import type { Pool, PoolClient } from "pg";

import { ResearchApiError } from "./research-errors.ts";

type CustomerStatusAction = "freeze" | "restore" | "archive";

export async function changeOperationsCustomerStatus(pool: Pool, input: {
  actorUserId: string;
  customerId: string;
  action: CustomerStatusAction;
  reason: string;
  authorize: (client: PoolClient, customerId: string) => Promise<void>;
  now?: Date;
}) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new ResearchApiError("CUSTOMER_REASON_INVALID", "操作原因需要 3–500 个字符", 422);
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await input.authorize(client, input.customerId);
    const customer = (await client.query<{ status: string }>(`
      SELECT status FROM users WHERE id=$1 AND role='customer' FOR UPDATE
    `, [input.customerId])).rows[0];
    if (!customer) throw new ResearchApiError("CUSTOMER_NOT_FOUND", "客户不存在或不在当前数据范围", 404);
    const valid = input.action === "freeze" ? customer.status === "active"
      : input.action === "archive" ? ["active", "frozen"].includes(customer.status)
        : ["frozen", "closed"].includes(customer.status);
    if (!valid) throw new ResearchApiError("CUSTOMER_STATE_CONFLICT", "客户状态已变化，请刷新后重试", 409, { currentStatus: customer.status, action: input.action });
    const nextStatus = input.action === "freeze" ? "frozen" : input.action === "archive" ? "closed" : "active";
    await client.query("UPDATE users SET status=$2,updated_at=$3 WHERE id=$1", [input.customerId, nextStatus, now]);
    if (input.action === "archive") {
      await client.query(`
        INSERT INTO customer_profiles(id,customer_id,archived_at,archived_by,created_at,updated_at)
        VALUES($1,$2,$3,$4,$3,$3)
        ON CONFLICT(customer_id) DO UPDATE SET archived_at=EXCLUDED.archived_at,archived_by=EXCLUDED.archived_by,updated_at=EXCLUDED.updated_at
      `, [crypto.randomUUID(), input.customerId, now, input.actorUserId]);
    } else if (input.action === "restore") {
      await client.query("UPDATE customer_profiles SET archived_at=NULL,archived_by=NULL,updated_at=$2 WHERE customer_id=$1", [input.customerId, now]);
    }
    if (input.action !== "restore") {
      await client.query("UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL", [input.customerId, now]);
      await client.query(`
        UPDATE official_paper_portfolios AS portfolio
           SET access_status=CASE WHEN EXISTS(
             SELECT 1 FROM official_paper_positions AS position
              WHERE position.portfolio_id=portfolio.id AND position.quantity>0
           ) THEN 'close_only' ELSE 'read_only' END,
               updated_at=$2
         WHERE portfolio.customer_id=$1
      `, [input.customerId, now]);
    } else {
      await client.query(`
        UPDATE official_paper_portfolios AS portfolio
           SET access_status='active',updated_at=$2
         WHERE portfolio.customer_id=$1
           AND EXISTS(
             SELECT 1 FROM memberships AS membership
              WHERE membership.id=portfolio.membership_id
                AND membership.customer_id=portfolio.customer_id
                AND membership.status='active'
                AND (membership.expires_at IS NULL OR membership.expires_at::timestamptz>$2)
           )
      `, [input.customerId, now]);
    }
    await client.query(`
      INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key)
      VALUES($1,$2,'in_app','account',$3,$4,'queued',$5,$6)
      ON CONFLICT(dedupe_key) DO NOTHING
    `, [crypto.randomUUID(), input.customerId, `customer_${input.action}`, JSON.stringify({ status: nextStatus, reason }), now, `customer-status:${input.customerId}:${input.action}:${now.toISOString()}`]);
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
      VALUES($1,$2,$3,'customer',$4,$5,$6,$7)
    `, [crypto.randomUUID(), input.actorUserId, `customer.${input.action}`, input.customerId, JSON.stringify({ status: customer.status }), JSON.stringify({ status: nextStatus, reason }), now]);
    await client.query("COMMIT");
    return { ok: true as const, status: nextStatus, message: input.action === "freeze" ? "客户已冻结，现有会话已撤销，模拟组合已停止新开仓" : input.action === "archive" ? "客户已归档，历史记录保留且模拟组合只读" : "客户已恢复；仅有效会员的模拟组合恢复运行" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
