import type { Pool, PoolClient } from "pg";

import { consumeAuthRateLimit } from "./auth-rate-limit.ts";
import { ResearchApiError } from "./research-errors.ts";

type RegistrationRateLimitInput = {
  phone: string;
  connectionBucketKey: string;
  now?: Date;
};

export async function consumeClientRegistrationRateLimit(
  pool: Pool,
  input: RegistrationRateLimitInput,
) {
  const phoneResult = await consumeAuthRateLimit(pool, {
    action: "register",
    audience: "client",
    bucketKeys: [`phone:${input.phone}`],
    maxAttempts: 5,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60,
    now: input.now,
  });
  if (!phoneResult.allowed) return phoneResult;
  return consumeAuthRateLimit(pool, {
    action: "register",
    audience: "client",
    bucketKeys: [input.connectionBucketKey],
    maxAttempts: 30,
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60,
    now: input.now,
  });
}

type RegisterInvitedClientInput = {
  codeHash: string;
  phone: string;
  phoneMasked: string;
  email: string;
  passwordHash: string;
  now?: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

type InvitationRow = {
  id: string;
  kind: "employee_reusable" | "public_pool_single_use";
  owner_employee_id: string | null;
  organization_id: string | null;
};

async function lockActiveInvitation(client: PoolClient, codeHash: string) {
  const candidate = await client.query<InvitationRow>(`
    SELECT id,kind,owner_employee_id,organization_id
    FROM client_registration_invitation($1)
  `, [codeHash]);
  const first = candidate.rows[0];
  if (!first) throw new ResearchApiError("INVITATION_INVALID", "邀请码无效或已使用", 400);
  return first;
}

async function invitationAttribution(client: PoolClient, invitationId: string, codeHash: string) {
  const result = await client.query<{ manager_id: string | null; supervisor_id: string | null }>(`
    SELECT manager_id,supervisor_id
      FROM client_registration_attribution($1,$2)
  `, [invitationId, codeHash]);
  const attribution = result.rows[0];
  if (!attribution) throw new ResearchApiError("INVITATION_INVALID", "邀请码无效或已使用", 400);
  return {
    managerId: attribution.manager_id,
    supervisorId: attribution.supervisor_id,
  };
}

function registrationConflict(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "23505") return null;
  const constraint = "constraint" in error ? String(error.constraint ?? "") : "";
  if (/phone/i.test(constraint)) return new ResearchApiError("PHONE_TAKEN", "该手机号已注册", 409);
  if (/email/i.test(constraint)) return new ResearchApiError("EMAIL_TAKEN", "该邮箱已注册", 409);
  return null;
}

export async function registerInvitedClient(pool: Pool, input: RegisterInvitedClientInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query<{ phone_exists: boolean; email_exists: boolean }>(`
      SELECT phone_exists,email_exists FROM client_registration_conflicts($1,$2)
    `, [input.phone, input.email]);
    if (duplicate.rows[0]?.phone_exists) throw new ResearchApiError("PHONE_TAKEN", "该手机号已注册", 409);
    if (duplicate.rows[0]?.email_exists) throw new ResearchApiError("EMAIL_TAKEN", "该邮箱已注册", 409);

    const invitation = await lockActiveInvitation(client, input.codeHash);
    const publicPool = invitation.kind === "public_pool_single_use";
    const { managerId, supervisorId } = publicPool
      ? { managerId: null, supervisorId: null }
      : await invitationAttribution(client, invitation.id, input.codeHash);
    const nowDate = input.now ?? new Date();
    const now = nowDate.toISOString();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();

    const insertedIdentity = await client.query<InvitationRow>(`
      SELECT kind,owner_employee_id,organization_id
      FROM client_insert_invited_customer($1,$2,$3,$4,$5,$6)
    `, [userId,input.email,input.phone,input.passwordHash,invitation.id,input.codeHash]);
    if (!insertedIdentity.rows[0]) throw new ResearchApiError("INVITATION_INVALID", "邀请码无效或已使用", 400);
    await client.query(`
      INSERT INTO customer_attributions(
        id,customer_id,source,status,branch_id,manager_id,supervisor_id,
        employee_id,effective_at,reason
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      crypto.randomUUID(), userId, publicPool ? "public_pool" : "employee_invite",
      publicPool ? "public_pool_pending" : "active",
      publicPool ? null : invitation.organization_id, managerId, supervisorId,
      publicPool ? null : invitation.owner_employee_id, publicPool ? null : now,
      publicPool ? "总公司客服一次性邀请码" : "邀请码自动归因",
    ]);
    if (!publicPool) {
      // 可复用链接不会被标记为 used（那是一次性码的语义），所以此前完全无法回答
      // 「这条链接带来了多少注册」。运营需要它来发现链接外泄——一条本该发给三五个
      // 人的链接突然涨到几百次，是唯一能看出来的信号。
      //
      // 必须走 SECURITY DEFINER 函数，不能直接 UPDATE：invitations 是客户端角色被
      // REVOKE ALL 的表（它存着全部邀请码）。直接写在开发机上一路绿灯，一到生产
      // 就是 42501，而客户只看到「注册失败」——整个注册流程会被这一行挡死。
      await client.query(
        "SELECT client_record_reusable_invitation_use($1,$2)",
        [invitation.id, now],
      );
    }
    await client.query(`
      INSERT INTO memberships(
        id,customer_id,plan_code,status,
        max_exchange_accounts,max_active_strategies
      ) VALUES($1,$2,'trial_monthly_equivalent','pending',1,3)
    `, [membershipId, userId]);
    if (publicPool) {
      const claimed = await client.query<{ claimed: boolean }>(`
        SELECT client_claim_registration_invitation($1,$2,$3,$4) AS claimed
      `, [invitation.id,input.codeHash,userId,now]);
      if (!claimed.rows[0]?.claimed) throw new ResearchApiError("INVITATION_INVALID", "邀请码无效或已使用", 400);
    }
    await client.query(`
      INSERT INTO notification_deliveries(
        id,user_id,channel,category,template_key,payload_json,scheduled_at,dedupe_key
      ) VALUES($1,$2,'in_app','membership_billing','trial_pending_disclosure',$3,$4,$5)
    `, [
      crypto.randomUUID(), userId,
      JSON.stringify({ status: "pending_disclosure", entitlement: "monthly" }),
      now, `trial-pending-disclosure:${membershipId}`,
    ]);
    await client.query(`
      INSERT INTO audit_logs(
        id,actor_user_id,action,subject_type,subject_id,after_json,ip_address,user_agent
      ) VALUES($1,$2,'customer.registered','user',$2,$3,$4,$5)
    `, [
      crypto.randomUUID(), userId,
      JSON.stringify({ phone: input.phoneMasked, emailProvided: !input.email.endsWith("@unverified.agentnovas.local"), invitationKind: invitation.kind, smsVerification: false }),
      input.ipAddress, input.userAgent,
    ]);
    await client.query("COMMIT");
    return { userId, membershipId, trialStatus: "PENDING_DISCLOSURE" as const };
  } catch (error) {
    await client.query("ROLLBACK");
    throw registrationConflict(error) ?? error;
  } finally {
    client.release();
  }
}
