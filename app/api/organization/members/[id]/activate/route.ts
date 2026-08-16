import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, authTokens, notificationDeliveries, sessions, users } from "@/db/schema";
import { hashPassword, randomToken } from "@/lib/auth";
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
      const message = member.status !== "pending" ? "该账户已激活或当前状态不能激活" : "无权激活该成员账户";
      return Response.json({ error: message }, { status: 403 });
    }

    const now = new Date().toISOString();
    const temporaryPassword = `Nova@${randomToken(6)}9`;
    await db.batch([
      db.update(users).set({
        passwordHash: await hashPassword(temporaryPassword),
        status: "active",
        emailVerifiedAt: now,
        updatedAt: now,
      }).where(and(eq(users.id, member.id), eq(users.status, "pending"))),
      db.update(authTokens).set({ usedAt: now }).where(and(
        eq(authTokens.userId, member.id),
        eq(authTokens.purpose, "verify_email"),
        isNull(authTokens.usedAt),
      )),
      db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, member.id), isNull(sessions.revokedAt))),
      db.update(notificationDeliveries).set({
        status: "failed",
        payloadJson: JSON.stringify({ supersededAt: now }),
        lastError: "superseded_by_manual_activation",
        updatedAt: now,
      }).where(and(
        eq(notificationDeliveries.userId, member.id),
        eq(notificationDeliveries.templateKey, "internal_account_invite"),
        eq(notificationDeliveries.status, "queued"),
      )),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: actor.id,
        action: "organization.member_manually_activated",
        subjectType: "user",
        subjectId: member.id,
        beforeJson: JSON.stringify({ status: member.status }),
        afterJson: JSON.stringify({ status: "active", emailVerifiedAt: now, temporaryPasswordIssued: true }),
        ipAddress: request.headers.get("cf-connecting-ip"),
        userAgent: request.headers.get("user-agent"),
      }),
    ]);

    const origin = new URL(request.url).origin;
    return Response.json({
      ok: true,
      memberId: member.id,
      email: member.email,
      temporaryPassword,
      loginUrl: `${origin}/?page=login`,
      message: "成员已激活，请立即复制登录信息；临时密码只显示本次",
    });
  } catch (error) {
    return responseError(error);
  }
}
