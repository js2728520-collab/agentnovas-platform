export const childRole: Record<string, string | undefined> = { hq_admin: "branch_admin", branch_admin: "manager", manager: "supervisor", supervisor: "employee", employee: "customer" };
export const branchApprovalRoles = ["branch_admin", "finance", "auditor"] as const;
export const invitationRoles = ["employee", "hq_support", "hq_admin"] as const;

/**
 * 谁能生成可复用邀请链接。
 *
 * 此前只允许 `employee`——于是经理、主管、分公司管理员都建不了自己的链接，
 * 而「上级邀请下级、各自带自己的识别码」正需要他们能建。
 *
 * 归因链本来就是从 owner_employee_id 沿 reports_to_user_id 往上走的
 * （见 migration 0040 的递归 CTE），任何一级作为起点都成立，不需要额外处理。
 *
 * `customer` 不在其中：客户不邀请客户。这条如果放开，归因链会从一个不在汇报体系
 * 里的节点起步，整套分公司/经理归属就没有意义了。
 */
const reusableInvitationRoles = new Set([
  "employee", "supervisor", "manager", "branch_admin", "hq_support", "hq_admin",
]);

export function canCreateInvitation(role: string, kind: string) {
  return kind === "employee_reusable"
    ? reusableInvitationRoles.has(role)
    : role === "hq_support" || role === "hq_admin";
}

export function isBranchReviewer(role: string) { return (branchApprovalRoles as readonly string[]).includes(role); }

export const roleLabels: Record<string, string> = { hq_admin: "总公司", hq_support: "总公司客服", branch_admin: "分公司", manager: "经理", supervisor: "主管", employee: "员工", customer: "客户", finance: "财务", auditor: "审核员" };

type MemberActivationActor = { id: string; role: string; organizationId: string | null };
type MemberActivationTarget = MemberActivationActor & { reportsToUserId: string | null; status: string };

export function canManuallyActivateMember(actor: MemberActivationActor, member: MemberActivationTarget) {
  if (member.status !== "pending" || member.role === "customer" || member.id === actor.id) return false;
  if (actor.role === "hq_admin") return member.role !== "hq_admin";
  if (actor.role === "branch_admin") {
    return Boolean(actor.organizationId)
      && member.organizationId === actor.organizationId
      && ["manager", "supervisor", "employee"].includes(member.role);
  }
  return member.reportsToUserId === actor.id && childRole[actor.role] === member.role;
}

export function canSeeCustomer(role: string, viewerId: string, viewerOrgId: string | null, row: { branchId: string | null; managerId: string | null; supervisorId: string | null; employeeId: string | null }) {
  if (role === "hq_admin" || role === "hq_support") return true;
  if (role === "branch_admin" || role === "finance" || role === "auditor") return !!viewerOrgId && row.branchId === viewerOrgId;
  if (role === "manager") return row.managerId === viewerId;
  if (role === "supervisor") return row.supervisorId === viewerId;
  if (role === "employee") return row.employeeId === viewerId;
  return false;
}
