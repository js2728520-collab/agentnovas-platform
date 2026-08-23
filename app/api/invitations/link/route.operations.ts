import { getDb } from "@/db";
import { auditLogs, invitations } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { sha256 } from "@/lib/auth";
import { canCreateInvitation } from "@/lib/permissions";
import { getPostgresPool } from "@/lib/postgres";
import { responseError } from "@/lib/session";
import {
  buildInvitationLink,
  findActiveReusableInvitation,
  generateInvitationCode,
  revokeReusableInvitation,
} from "@/lib/invitation-links";

/**
 * 「我的邀请链接」。
 *
 * 每人一条、反复使用、不为每个客户单独创建。链接自带识别码，注册时由 owner 沿
 * 汇报链把新客户归因到邀请人和他的上级（migration 0040 的递归 CTE）。
 *
 * GET 返回链接的状态与使用次数，**不返回明文**——库里只有哈希。
 * POST 生成或重新生成；重新生成会让旧链接立刻失效。
 */

function invitationBaseUrl(request: Request): string {
  // 用请求自己的 origin 而不是配置项：三个应用各有域名，写死一个会让运营端
  // 生成出指向错误站点的链接。
  return process.env.CLIENT_PUBLIC_BASE_URL?.trim() || new URL(request.url).origin;
}

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.invitations.view");
    const existing = await findActiveReusableInvitation(await getPostgresPool(), user.id);
    return Response.json({
      link: existing
        ? {
            id: existing.id,
            status: existing.status,
            useCount: existing.useCount,
            lastUsedAt: existing.lastUsedAt,
            createdAt: existing.createdAt,
            // 明文不落库，所以这里给不出链接本身。要拿回链接只能重新生成。
            plaintextAvailable: false,
          }
        : null,
      canCreate: canCreateInvitation(user.role, "employee_reusable"),
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.invitations.manage");
    if (!canCreateInvitation(user.role, "employee_reusable")) {
      return Response.json({ error: "当前角色不能生成邀请链接" }, { status: 403 });
    }
    if (!user.organizationId) {
      // 没有组织归属的账号生成的链接，会让新客户挂进一条断掉的归因链。
      return Response.json({ error: "账号尚未归属组织，无法生成邀请链接" }, { status: 409 });
    }

    const pool = await getPostgresPool();
    const now = new Date().toISOString();
    // 先撤旧的：唯一索引不允许同时存在两条有效链接，忘了撤会直接撞约束，
    // 而不是悄悄留下一条仍然有效的旧链接。
    const revoked = await revokeReusableInvitation(pool, {
      ownerEmployeeId: user.id, revokedBy: user.id, now,
    });

    const code = generateInvitationCode(8);
    const id = crypto.randomUUID();
    const db = getDb();
    await db.batch([
      db.insert(invitations).values({
        id,
        codeHash: await sha256(code),
        kind: "employee_reusable",
        issuerUserId: user.id,
        ownerEmployeeId: user.id,
        organizationId: user.organizationId,
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: user.id,
        action: revoked.revokedId ? "invitation.link_regenerated" : "invitation.link_created",
        subjectType: "invitation",
        subjectId: id,
        // 不记明文码。审计要能回答「谁在什么时候换了链接」，不需要能回答「链接是什么」。
        afterJson: JSON.stringify({ replacedInvitationId: revoked.revokedId }),
      }),
    ]);

    return Response.json({
      link: buildInvitationLink(invitationBaseUrl(request), code),
      code,
      replacedPreviousLink: revoked.revokedId !== null,
      warning: "链接明文仅本次显示，请立即保存。想要回链接只能重新生成，而重新生成会让当前链接失效。",
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
