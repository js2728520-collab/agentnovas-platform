import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, authTokens, notificationDeliveries, users } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { randomToken, sha256 } from "@/lib/auth";
import { canAccessOrganization } from "@/lib/operations-access";
import { encryptNotificationToken } from "@/lib/notification-secrets";
import { canManuallyActivateMember } from "@/lib/permissions";
import { getPostgresPool } from "@/lib/postgres";
import { responseError } from "@/lib/session";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.organization.manage");
    const { id } = await params;
    const db = getDb();
    const member = (await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      reportsToUserId: users.reportsToUserId,
      status: users.status,
      invitedViaInvitationId: users.invitedViaInvitationId,
    }).from(users).where(eq(users.id, id)).limit(1))[0];

    if (!member) return Response.json({ error: "成员账户不存在" }, { status: 404 });
    if (member.organizationId
      ? !canAccessOrganization(scope, { userId: actor.id, organizationId: actor.organizationId }, member.organizationId, organizationIds)
      : scope !== "PLATFORM") {
      return Response.json({ error: "无权邀请授权范围外的成员" }, { status: 403 });
    }
    if (!canManuallyActivateMember(actor, member)) {
      const message = member.status !== "pending" ? "该账户已激活或当前状态不能邀请" : "无权邀请该成员账户";
      return Response.json({ error: message }, { status: 403 });
    }

    const pool = await getPostgresPool();

    // 通过邀请链接注册的人，邀请人本人不能批准。
    //
    // canManuallyActivateMember 只挡「激活自己」。对手工录入影响不大——上级本来就
    // 知道自己录了谁；但对链接注册是致命的：生成链接的人同时批准通过链接进来的人，
    // 等于一个人走完全程，双人复核名存实亡。
    if (member.invitedViaInvitationId) {
      const invitation = (await pool.query<{ owner_employee_id: string | null }>(
        "SELECT owner_employee_id FROM invitations WHERE id = $1",
        [member.invitedViaInvitationId],
      )).rows[0];
      if (invitation?.owner_employee_id === actor.id) {
        return Response.json({
          code: "INVITER_CANNOT_APPROVE",
          error: "该成员通过你的邀请链接注册，需由另一位管理员复核",
        }, { status: 403 });
      }
    }

    // 角色分配所在的端随角色而定：技术人员在运维端，其余内部角色在运营端。
    // 此前这里写死 operations，技术人员会被判成「尚未完成显式角色分配」——
    // 一个正确但完全看不出原因的失败。
    const assignmentApp = member.role === "tech_staff" ? "maintenance" : "operations";
    const assignment = await pool.query(`
      SELECT 1 FROM user_role_assignments
      WHERE user_id = $1 AND application_id = $2 AND status = 'active'
        AND effective_at <= now() AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `, [member.id, assignmentApp]);
    if (!assignment.rowCount) return Response.json({ error: "成员尚未完成显式角色分配" }, { status: 409 });

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 48 * 3600_000).toISOString();
    const activationToken = randomToken();
    const encryptedToken = await encryptNotificationToken(activationToken);
    await db.batch([
      db.update(authTokens).set({ usedAt: now }).where(and(
        eq(authTokens.userId, member.id),
        eq(authTokens.purpose, "reset_password"),
        isNull(authTokens.usedAt),
      )),
      db.insert(authTokens).values({
        id: crypto.randomUUID(), userId: member.id, tokenHash: await sha256(activationToken),
        purpose: "reset_password", tokenAudience: "operations", expiresAt,
      }),
      db.insert(notificationDeliveries).values({
        id: crypto.randomUUID(), userId: member.id, channel: "email", category: "login_security",
        templateKey: "internal_account_invite",
        payloadJson: JSON.stringify({ encryptedToken, role: member.role, activation: true, audience: "operations", expiresAt }),
        secretKind: "internal_account_invite",
        secretExpiresAt: expiresAt,
        scheduledAt: now,
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(), actorUserId: actor.id,
        action: "organization.member_activation_invitation_reissued",
        subjectType: "user", subjectId: member.id,
        beforeJson: JSON.stringify({ status: member.status }),
        afterJson: JSON.stringify({ status: "pending", deliveryStatus: "queued" }),
        userAgent: request.headers.get("user-agent"),
      }),
    ]);
    return Response.json({
      ok: true,
      memberId: member.id,
      deliveryStatus: "queued",
      message: "激活邀请已进入邮件队列；完成密码设置前账户仍保持待激活",
    });
  } catch (error) {
    return responseError(error);
  }
}
