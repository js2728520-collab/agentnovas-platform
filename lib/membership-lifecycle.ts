import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

type DueMembership = {
  id: string;
  customer_id: string;
  plan_code: string;
  status: string;
  starts_at: string | null;
  expires_at: string;
  grace_ends_at: string | null;
  email_verified_at: string | null;
};

export async function reconcileMembershipAccessTransitions(
  pool: Pool,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date();
  const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit ?? 100, 500)) : 100;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<DueMembership>(`
      SELECT membership.id,membership.customer_id,membership.plan_code,membership.status,
             membership.starts_at,membership.expires_at,membership.grace_ends_at,user_account.email_verified_at
        FROM memberships AS membership
        JOIN users AS user_account ON user_account.id=membership.customer_id
       WHERE (
         membership.status IN ('active','trial')
         AND membership.expires_at IS NOT NULL
         AND membership.expires_at::timestamptz <= $1
       ) OR (
         membership.status='grace'
         AND (membership.grace_ends_at IS NULL OR membership.grace_ends_at::timestamptz <= $1)
       )
       ORDER BY membership.expires_at,membership.id
       LIMIT $2
       FOR UPDATE OF membership SKIP LOCKED
    `, [now.toISOString(), limit]);
    let transitioned = 0;
    for (const membership of due.rows) {
      const graceActive = Boolean(membership.grace_ends_at && now < new Date(membership.grace_ends_at));
      const nextStatus = membership.status !== "grace" && graceActive ? "grace" : "read_only";
      if (nextStatus === membership.status) continue;
      const isTrial = membership.plan_code === "trial_monthly_equivalent";
      const eventType = nextStatus === "grace"
        ? isTrial ? "trial_grace_started" : "membership_grace_started"
        : "read_only_started";
      const templateKey = nextStatus === "grace" ? "membership_grace_started" : "membership_read_only";
      await client.query(`UPDATE memberships SET status=$2,updated_at=$3 WHERE id=$1`, [membership.id, nextStatus, now.toISOString()]);
      if (nextStatus === "read_only") {
        await client.query(`
          UPDATE official_paper_portfolios AS portfolio
             SET access_status=CASE WHEN EXISTS (
               SELECT 1 FROM official_paper_positions AS position
                WHERE position.portfolio_id=portfolio.id AND position.status='open'
             ) THEN 'close_only' ELSE 'read_only' END,
                 updated_at=$2
           WHERE portfolio.membership_id=$1
        `, [membership.id, now.toISOString()]);
      }
      const state = {
        fromStatus: membership.status,
        toStatus: nextStatus,
        planCode: membership.plan_code,
        expiresAt: membership.expires_at,
        graceEndsAt: membership.grace_ends_at,
      };
      await client.query(`
        INSERT INTO membership_access_events(id,membership_id,customer_id,event_type,effective_at,state_json,dedupe_key)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT(dedupe_key) DO NOTHING
      `, [randomUUID(), membership.id, membership.customer_id, eventType, now.toISOString(), JSON.stringify(state), `membership:${membership.id}:${eventType}`]);
      const payload = nextStatus === "grace"
        ? { planCode: membership.plan_code, graceEndsAt: membership.grace_ends_at }
        : { planCode: membership.plan_code, effectiveAt: now.toISOString() };
      const channels = membership.email_verified_at ? ["in_app", "email"] : ["in_app"];
      for (const channel of channels) {
        await client.query(`
          INSERT INTO notification_deliveries(
            id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key
          ) VALUES($1,$2,$3,'membership_billing',$4,$5,'queued',$6,$7)
          ON CONFLICT(dedupe_key) DO NOTHING
        `, [randomUUID(), membership.customer_id, channel, templateKey, JSON.stringify(payload), now.toISOString(), `membership:${membership.id}:${eventType}:${channel}`]);
      }
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
        VALUES($1,NULL,$2,'membership',$3,$4::jsonb,$5::jsonb,$6)
      `, [randomUUID(), `membership.lifecycle.${eventType}`, membership.id, JSON.stringify({ status: membership.status }), JSON.stringify(state), now.toISOString()]);
      transitioned += 1;
    }
    await client.query("COMMIT");
    return { processed: due.rows.length, transitioned };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
