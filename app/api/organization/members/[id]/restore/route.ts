import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, authTokens, notificationDeliveries, sessions, users } from "@/db/schema";
import { canRestoreClosedMember, canRestoreFrozenMember } from "@/lib/permissions";
import { requireUser, responseError } from "@/lib/session";

const restoreRoles = ["hq_admin", "branch_admin", "manager", "supervisor"] as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser(request, [...restoreRoles]);
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
    if (member.status !== "closed" && member.status !== "frozen") return Response.json({ error: "只有已关闭或已停用账户可以恢复" }, { status: 409 });
    const restoringFrozen = member.status === "frozen";
    if (!(restoringFrozen ? canRestoreFrozenMember(actor, member) : canRestoreClosedMember(actor, member))) return Response.json({ error: "无权恢复该成员账户" }, { status: 403 });

    const now = new Date().toISOString();
    const restoreStatement = restoringFrozen
      ? db.update(users).set({ status: "active", emailVerifiedAt: now, updatedAt: now }).where(and(eq(users.id, member.id), eq(users.status, "frozen")))
      : db.update(users).set({ status: "pending", emailVerifiedAt: null, updatedAt: now }).where(and(eq(users.id, member.id), eq(users.status, "closed")));
    await db.batch([
      restoreStatement,
      db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, member.id), isNull(sessions.revokedAt))),
      db.update(authTokens).set({ usedAt: now }).where(and(eq(authTokens.userId, member.id), isNull(authTokens.usedAt))),
      db.update(notificationDeliveries).set({
        status: "failed",
        payloadJson: JSON.stringify({ supersededAt: now }),
        lastError: "superseded_by_account_restore",
        updatedAt: now,
      }).where(and(
        eq(notificationDeliveries.userId, member.id),
        eq(notificationDeliveries.status, "queued"),
      )),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: actor.id,
        action: "organization.member_restored",
        subjectType: "user",
        subjectId: member.id,
        beforeJson: JSON.stringify({ status: member.status }),
        afterJson: JSON.stringify({ status: restoringFrozen ? "active" : "pending", restoredAt: now, requiresManualActivation: !restoringFrozen }),
        ipAddress: request.headers.get("cf-connecting-ip"),
        userAgent: request.headers.get("user-agent"),
      }),
    ]);

    return Response.json({
      ok: true,
      memberId: member.id,
      email: member.email,
      status: restoringFrozen ? "active" : "pending",
      message: restoringFrozen ? "账户已恢复，可以重新登录" : "账户已恢复为待激活，请继续手动激活并保存新临时密码",
    });
  } catch (error) {
    return responseError(error);
  }
}
