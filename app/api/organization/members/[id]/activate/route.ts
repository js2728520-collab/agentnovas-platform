import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, authTokens, notificationDeliveries, users } from "@/db/schema";
import { randomToken, sha256 } from "@/lib/auth";
import { canManuallyActivateMember } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";

const activationRoles = ["hq_admin", "branch_admin", "manager", "supervisor"] as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser(request, [...activationRoles]);
    const { id } = await params;
    const db = getDb();
    const member = (await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      reportsToUserId: users.reportsToUserId,
      status: users.status,
    }).from(users).where(eq(users.id, id)).limit(1))[0];

    if (!member) return Response.json({ error: "成员账户不存在" }, { status: 404 });
    if (!canManuallyActivateMember(actor, member)) {
      const message = member.status !== "pending" ? "该账户已激活或当前状态不能邀请" : "无权邀请该成员账户";
      return Response.json({ error: message }, { status: 403 });
    }

    const now = new Date().toISOString();
    const activationToken = randomToken();
    await db.batch([
      db.update(authTokens).set({ usedAt: now }).where(and(
        eq(authTokens.userId, member.id),
        eq(authTokens.purpose, "reset_password"),
        isNull(authTokens.usedAt),
      )),
      db.insert(authTokens).values({
        id: crypto.randomUUID(), userId: member.id, tokenHash: await sha256(activationToken),
        purpose: "reset_password", expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
      }),
      db.insert(notificationDeliveries).values({
        id: crypto.randomUUID(), userId: member.id, channel: "email", category: "login_security",
        templateKey: "internal_account_invite",
        payloadJson: JSON.stringify({ token: activationToken, role: member.role, activation: true }),
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
