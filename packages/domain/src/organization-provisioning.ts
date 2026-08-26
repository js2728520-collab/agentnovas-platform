/**
 * 组织开设判定。
 *
 * 创建分支管理员会**顺带建一个分公司**——这是整棵组织树上唯一的建组织入口。
 * 名称留空时旧实现会退化成邮箱前缀（`lib/internal-member-provisioning.ts` 的
 * fallback），产出一个像 "zhangsan" 的分公司名。组织树、业绩归因、数据可见范围
 * 全挂在那个组织上，事后没人知道它代表什么，而重命名要动一堆已经引用它的记录。
 *
 * 判定放在域层，是因为它同时被 API 与界面用到：界面据此决定输入框出不出现、
 * 提交按钮亮不亮，API 据此拒绝请求。两处各写一遍迟早会不一致。
 */

/** 创建这个角色是否会顺带开一个新组织。 */
export function createsOrganization(role: string): boolean {
  return role === "branch_admin";
}

/**
 * Operations 的五级业务角色。数组顺序同时表达授权层级，越靠前权限层级越高。
 * 技术、财务、审核和客服角色不属于这条业务注册链。
 */
export const INTERNAL_OPERATION_ROLE_HIERARCHY = [
  "hq_admin",
  "branch_admin",
  "manager",
  "supervisor",
  "employee",
] as const;

export type InternalOperationRole = typeof INTERNAL_OPERATION_ROLE_HIERARCHY[number];

function internalOperationRoleIndex(role: string): number {
  return (INTERNAL_OPERATION_ROLE_HIERARCHY as readonly string[]).indexOf(role);
}

/** 返回生成者可以授予的全部下级角色，顺序从高到低。 */
export function invitableInternalRoles(issuerRole: string): InternalOperationRole[] {
  const issuerIndex = internalOperationRoleIndex(issuerRole);
  if (issuerIndex < 0) return [];
  return INTERNAL_OPERATION_ROLE_HIERARCHY.slice(issuerIndex + 1);
}

/** 角色链接只能向下授权，不能创建总公司总经理或非业务角色。 */
export function canIssueInternalRegistrationLink(issuerRole: string, targetRole: string): boolean {
  return invitableInternalRoles(issuerRole).includes(targetRole as InternalOperationRole);
}

export type InternalRegistrationLinkScopeDecision =
  | {
      ok: true;
      organizationMode: "CREATE_BRANCH" | "EXISTING_ORGANIZATION";
      organizationId: string | null;
    }
  | {
      ok: false;
      code:
        | "ROLE_ESCALATION_FORBIDDEN"
        | "TARGET_ORGANIZATION_REQUIRED"
        | "ISSUER_ORGANIZATION_REQUIRED"
        | "TARGET_ORGANIZATION_OUT_OF_SCOPE";
    };

/**
 * 把角色层级与组织范围一起冻结进注册链接。
 *
 * 总公司生成分公司总经理链接时，分公司由注册事务创建；总公司直接生成更低角色时
 * 必须显式锁定一个既有分公司。其余生成者只能沿用自己的分公司，不能借参数跨组织。
 */
export function resolveInternalRegistrationLinkScope(input: {
  issuerRole: string;
  targetRole: string;
  issuerOrganizationId: string | null;
  targetOrganizationId: string | null;
}): InternalRegistrationLinkScopeDecision {
  if (!canIssueInternalRegistrationLink(input.issuerRole, input.targetRole)) {
    return { ok: false, code: "ROLE_ESCALATION_FORBIDDEN" };
  }

  if (input.targetRole === "branch_admin") {
    return {
      ok: true,
      organizationMode: "CREATE_BRANCH",
      organizationId: null,
    };
  }

  if (input.issuerRole === "hq_admin") {
    return input.targetOrganizationId
      ? {
          ok: true,
          organizationMode: "EXISTING_ORGANIZATION",
          organizationId: input.targetOrganizationId,
        }
      : { ok: false, code: "TARGET_ORGANIZATION_REQUIRED" };
  }

  if (!input.issuerOrganizationId) {
    return { ok: false, code: "ISSUER_ORGANIZATION_REQUIRED" };
  }
  if (input.targetOrganizationId && input.targetOrganizationId !== input.issuerOrganizationId) {
    return { ok: false, code: "TARGET_ORGANIZATION_OUT_OF_SCOPE" };
  }
  return {
    ok: true,
    organizationMode: "EXISTING_ORGANIZATION",
    organizationId: input.issuerOrganizationId,
  };
}

export const ORGANIZATION_NAME_MIN = 2;
export const ORGANIZATION_NAME_MAX = 120;

export type OrganizationNameCheck =
  | { ok: true; name: string | null }
  | { ok: false; code: "ORGANIZATION_NAME_REQUIRED"; message: string };

/**
 * 校验开设组织所需的名称。
 *
 * 不建组织的角色返回 `name: null`——调用方不该给它传名称，传了也不用。
 * 返回显式结果而不是抛错：错误身份属于 HTTP 层的对外契约，域层不该知道 422
 * （见 packages/domain/CLAUDE.md「域层返回决策，服务层抛错误」）。
 */
export function checkOrganizationName(role: string, rawName: unknown): OrganizationNameCheck {
  if (!createsOrganization(role)) return { ok: true, name: null };

  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length < ORGANIZATION_NAME_MIN || name.length > ORGANIZATION_NAME_MAX) {
    return {
      ok: false,
      code: "ORGANIZATION_NAME_REQUIRED",
      message: `创建分支管理员时必须填写分公司名称（${ORGANIZATION_NAME_MIN}–${ORGANIZATION_NAME_MAX} 字）`,
    };
  }
  return { ok: true, name };
}
