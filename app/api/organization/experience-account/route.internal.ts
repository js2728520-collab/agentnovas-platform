import { requireUser } from "@/lib/session";
import { hashPassword } from "@/lib/auth";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";
import { responseError } from "@/lib/session";
import { provisionInternalExperienceAccount } from "@/lib/internal-experience-account";

/**
 * 「我的体验账号」。
 *
 * 公司人员要熟悉业务，就需要一个真实的客户账号。工号账号进不了客户端——
 * migration 0040 的 RESTRICTIVE RLS 让客户端 Web 的数据库角色只能看到
 * `role = 'customer'` 的用户与会话，放开那条等于让公网应用的数据库角色读到全部
 * 内部账号。所以体验账号是一个**独立的客户账号**。
 *
 * 它不走客户邀请链接：那条路会把它挂进归因体系，员工的仓位会算成他自己的业绩，
 * 主管、经理、分公司跟着一路分成——一个可以自我刷单的口子。这里直接建归因行并打
 * is_internal，且 employee_id / manager_id / supervisor_id 全部留空。
 *
 * 后缀 `.internal`：运营端与运维端的人都需要它（技术人员同样要熟悉业务），
 * 客户端不该有。
 *
 * **鉴权用 requireUser 而不是 requireAccessPermission**：后者的权限键带 appId，
 * `access-control` 对「当前 audience ≠ 权限所属 audience」直接返回 404。用
 * `ops.organization.view` 会让运维端的技术人员完全调不到这条接口，而报错是 404
 * ——最难查的那种。
 *
 * 这里也确实不需要细粒度权限：任何内部账号都可以给**自己**开一个体验账号，
 * 开不了别人的（ownerUserId 恒为当前登录者）。
 */

/** 可以给自己开体验账号的角色。客户不在其中——客户本来就是客户。 */
const INTERNAL_ROLES: Parameters<typeof requireUser>[1] = [
  "hq_admin", "hq_support", "branch_admin", "manager", "supervisor",
  "employee", "finance", "auditor", "tech_staff",
];

export async function GET(request: Request) {
  try {
    const user = await requireUser(request, INTERNAL_ROLES);
    const row = (await (await getPostgresPool()).query<{
      customer_id: string; internal_reason: string; effective_at: string | null; email: string;
    }>(
      `SELECT attribution.customer_id, attribution.internal_reason, attribution.effective_at,
              account.email
         FROM customer_attributions AS attribution
         JOIN users AS account ON account.id = attribution.customer_id
        WHERE attribution.internal_owner_user_id = $1
          AND attribution.is_internal = true AND attribution.status = 'active'
        LIMIT 1`,
      [user.id],
    )).rows[0];
    return Response.json({
      account: row
        ? {
            customerId: row.customer_id,
            email: row.email,
            reason: row.internal_reason,
            createdAt: row.effective_at,
          }
        : null,
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request, INTERNAL_ROLES);
    const body = await readResearchJson(request, 4_096);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ResearchApiError("EMAIL_INVALID", "请输入有效邮箱", 400);
    }
    // 体验账号必须用另一个邮箱：同一个邮箱注册两个账号，登录时分不清进的是哪一个。
    if (email === user.email?.trim().toLowerCase()) {
      throw new ResearchApiError("EMAIL_SAME_AS_WORK", "体验账号需要使用与工号账号不同的邮箱", 400);
    }
    if (!/^\d{6,20}$/.test(phone)) {
      throw new ResearchApiError("PHONE_INVALID", "请输入有效手机号", 400);
    }
    if (password.length < 12) {
      throw new ResearchApiError("PASSWORD_TOO_SHORT", "密码至少 12 位", 400);
    }
    if (!reason) {
      throw new ResearchApiError("REASON_REQUIRED", "请填写开通体验账号的原因", 400);
    }

    try {
      const result = await provisionInternalExperienceAccount(await getPostgresPool(), {
        ownerUserId: user.id,
        customerUserId: crypto.randomUUID(),
        email,
        phone,
        passwordHash: await hashPassword(password),
        reason,
        organizationId: user.organizationId,
      });
      return Response.json({
        account: { customerId: result.customerId, email },
        message: "体验账号已开通。用这个邮箱和密码登录客户端即可，它不计入任何业绩统计。",
      }, { status: 201 });
    } catch (error) {
      // 服务层的错误码是英文常量，直接抛给前端会显示成一串看不懂的东西。
      const code = error instanceof Error ? error.message : "";
      if (code === "INTERNAL_EXPERIENCE_ALREADY_EXISTS") {
        throw new ResearchApiError(code, "你已经有一个体验账号了", 409);
      }
      if (code === "INTERNAL_EXPERIENCE_OWNER_NOT_INTERNAL") {
        throw new ResearchApiError(code, "只有内部人员可以开通体验账号", 403);
      }
      throw error;
    }
  } catch (error) {
    return responseError(error);
  }
}
