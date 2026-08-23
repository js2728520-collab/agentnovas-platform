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
