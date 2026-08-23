import { getDb } from "@/db";
import { approvalRequests, auditLogs, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword, sha256 } from "@/lib/auth";
import { encryptNotificationToken } from "@/lib/notification-secrets";
import { provisionInternalMember } from "@/lib/internal-member-provisioning";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { responseError } from "@/lib/session";
import {
  findStaffInvitationByHash,
  isStaffInvitationUsable,
  recordInvitationUse,
} from "@/lib/invitation-links";

/**
 * 通过员工邀请链接注册。
 *
 * 后缀是 `.internal` 而不是 `.operations`：它同时服务运营端与运维端
 * （技术人员的链接指向运维端，其余内部角色指向运营端），而客户端不该有它。
 *
 * 放在 `/api/organization/` 而不是 `/api/auth/`：后者在 API 清单里归属客户端，
 * 而员工注册发生在运营端/运维端。放错前缀会让架构边界检查报「后缀与 audience
 * 不一致」——那条规则挡的正是「客户端能调到运营端接口」这类错配。
 *
 * **这条路由不需要登录**——注册的人还没有账号。但它也不会创建一个可用的账号：
 * 产出的是一个 `pending` 成员 + 一张审批单，仍需第二个人放行。
 *
 * 链接只省掉「上级手工录入对方姓名邮箱角色」这一步，不省审批。48 小时的期限把
 * 窗口收窄，真正的闸门是复核人——即使链接在窗口内外泄，多出来的账号也只能停在
 * 待批准状态。
 *
 * 角色不由注册者选，来自链接的 target_role（由邀请人的 childRole 推出）。
 */

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function POST(request: Request) {
  try {
    const body = await readResearchJson(request, 4_096);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    if (!code) throw new ResearchApiError("STAFF_INVITE_REQUIRED", "缺少邀请链接标识", 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ResearchApiError("EMAIL_INVALID", "请输入有效邮箱", 400);
    }
    if (password.length < 12) {
      throw new ResearchApiError("PASSWORD_TOO_SHORT", "密码至少 12 位", 400);
    }

    const pool = await getPostgresPool();
    const invitation = await findStaffInvitationByHash(pool, await sha256(code));
    // 不区分「链接不存在」与「链接已失效」：区分开等于给暴力猜码的人一个信号。
    const usable = invitation
      ? isStaffInvitationUsable(invitation, new Date())
      : { usable: false, reason: "STAFF_LINK_NOT_FOUND" };
    if (!invitation || !usable.usable) {
      throw new ResearchApiError("STAFF_INVITE_INVALID", "邀请链接无效或已过期，请向邀请人索取新链接", 400);
    }
    if (!invitation.targetRole) {
      throw new ResearchApiError("STAFF_INVITE_INVALID", "邀请链接缺少目标角色", 400);
    }

    const db = getDb();
    if ((await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]) {
      throw new ResearchApiError("EMAIL_TAKEN", "该邮箱已注册", 409);
    }

    const now = new Date();
    const userId = crypto.randomUUID();
    const activationToken = crypto.randomUUID();
    const provisioned = await provisionInternalMember(pool, {
      actorUserId: invitation.ownerEmployeeId!,
      userId,
      email,
      // 注册者自己设的密码。与手工录入路径不同——那条路发的是一次性激活令牌，
      // 而链接注册的人就在当场，没有理由再绕一圈邮件。
      passwordHash: await hashPassword(password),
      role: invitation.targetRole as Parameters<typeof provisionInternalMember>[1]["role"],
      organizationId: invitation.organizationId,
      // 汇报关系来自链接的归属人——这就是「谁邀请的」在组织架构上的落点。
      reportsToUserId: invitation.ownerEmployeeId!,
      activationTokenHash: await sha256(activationToken),
      encryptedNotificationToken: await encryptNotificationToken(activationToken),
      reason: "通过员工邀请链接注册",
      now,
    });

    const approvalId = crypto.randomUUID();
    await db.batch([
      db.insert(approvalRequests).values({
        id: approvalId,
        type: "internal_member_activation",
        branchId: invitation.organizationId,
        subjectType: "user",
        subjectId: userId,
        payloadJson: JSON.stringify({
          email,
          role: invitation.targetRole,
          invitedBy: invitation.ownerEmployeeId,
          via: "staff_invitation_link",
        }),
        requestedBy: invitation.ownerEmployeeId!,
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: userId,
        action: "invitation.staff_link_used",
        subjectType: "user",
        subjectId: userId,
        afterJson: JSON.stringify({
          invitationId: invitation.id,
          invitedBy: invitation.ownerEmployeeId,
          role: invitation.targetRole,
          approvalRequestId: approvalId,
        }),
      }),
    ]);
    await recordInvitationUse(pool, { invitationId: invitation.id, now: now.toISOString() });

    return Response.json({
      status: "pending_approval",
      organizationId: provisioned.organizationId,
      message: "注册已提交。账号需要另一位管理员复核通过后才能登录。",
    }, { status: 202 });
  } catch (error) {
    return responseError(error);
  }
}
