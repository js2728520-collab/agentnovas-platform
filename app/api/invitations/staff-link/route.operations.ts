import { getDb } from "@/db";
import { auditLogs, invitations } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { sha256 } from "@/lib/auth";
import { childRole, roleLabels } from "@/lib/permissions";
import { getPostgresPool } from "@/lib/postgres";
import { responseError } from "@/lib/session";
import {
  buildStaffInvitationLink,
  findActiveStaffInvitation,
  generateInvitationCode,
  revokeStaffInvitation,
  staffInvitationAudience,
  staffInvitationExpiry,
} from "@/lib/invitation-links";

/**
 * 「我的员工邀请链接」。
 *
 * 与客户链接的区别不在能不能复用，而在**有效期与审批**：48 小时过期，且通过它注册
 * 的人只能进待批准状态，仍需第二个人放行。
 *
 * 目标角色由 childRole 推出，不可自选——能自选角色等于能给自己造上级。
 * 技术人员不在这条链上，由 hq_admin 在成员页直接创建。
 */

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.organization.view");
    const target = childRole[user.role];
    const existing = await findActiveStaffInvitation(await getPostgresPool(), user.id);
    return Response.json({
      link: existing
        ? {
            id: existing.id,
            status: existing.status,
            useCount: existing.useCount,
            lastUsedAt: existing.lastUsedAt,
            createdAt: existing.createdAt,
            expiresAt: existing.expiresAt,
            targetRole: existing.targetRole,
            targetRoleLabel: existing.targetRole ? roleLabels[existing.targetRole] ?? existing.targetRole : null,
          }
        : null,
      targetRole: target && target !== "customer" ? target : null,
      targetRoleLabel: target && target !== "customer" ? roleLabels[target] ?? target : null,
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.organization.manage");
    const target = childRole[user.role];
    if (!target || target === "customer") {
      return Response.json({ error: "当前角色没有可邀请的下一级" }, { status: 403 });
    }
    if (!user.organizationId) {
      return Response.json({ error: "账号尚未归属组织，无法生成邀请链接" }, { status: 409 });
    }

    const pool = await getPostgresPool();
    const now = new Date();
    const nowIso = now.toISOString();
    // 唯一索引不允许同时存在两条有效的员工链接；先撤旧的，否则会直接撞约束。
    const revoked = await revokeStaffInvitation(pool, {
      ownerEmployeeId: user.id, revokedBy: user.id, now: nowIso,
    });

    const code = generateInvitationCode(10);
    const id = crypto.randomUUID();
    const expiresAt = staffInvitationExpiry(now);
    const db = getDb();
    await db.batch([
      db.insert(invitations).values({
        id,
        codeHash: await sha256(code),
        kind: "staff_reusable",
        issuerUserId: user.id,
        ownerEmployeeId: user.id,
        organizationId: user.organizationId,
        expiresAt,
        targetRole: target,
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: user.id,
        action: revoked.revokedId ? "invitation.staff_link_regenerated" : "invitation.staff_link_created",
        subjectType: "invitation",
        subjectId: id,
        afterJson: JSON.stringify({ targetRole: target, expiresAt, replacedInvitationId: revoked.revokedId }),
      }),
    ]);

    return Response.json({
      link: buildStaffInvitationLink(
        process.env.OPERATIONS_PUBLIC_BASE_URL?.trim() || new URL(request.url).origin,
        code,
        staffInvitationAudience(target),
      ),
      expiresAt,
      targetRole: target,
      targetRoleLabel: roleLabels[target] ?? target,
      replacedPreviousLink: revoked.revokedId !== null,
      warning: "链接明文仅本次显示。48 小时后自动失效；通过它注册的人仍需另一位管理员复核才能生效。",
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.organization.manage");
    const result = await revokeStaffInvitation(await getPostgresPool(), {
      ownerEmployeeId: user.id, revokedBy: user.id, now: new Date().toISOString(),
    });
    if (!result.revokedId) return Response.json({ error: "当前没有生效中的邀请链接" }, { status: 409 });
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "invitation.staff_link_revoked",
      subjectType: "invitation",
      subjectId: result.revokedId,
      afterJson: JSON.stringify({ revokedBy: user.id }),
    });
    return Response.json({ revoked: true });
  } catch (error) {
    return responseError(error);
  }
}
