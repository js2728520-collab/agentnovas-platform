export const childRole: Record<string, string | undefined> = { hq_admin: "branch_admin", branch_admin: "manager", manager: "supervisor", supervisor: "employee", employee: "customer" };
export const branchApprovalRoles = ["branch_admin", "finance", "auditor"] as const;
export const invitationRoles = ["employee", "hq_support", "hq_admin"] as const;

export function canCreateInvitation(role: string, kind: string) {
  return kind === "employee_reusable" ? role === "employee" : role === "hq_support" || role === "hq_admin";
}

export function isBranchReviewer(role: string) { return (branchApprovalRoles as readonly string[]).includes(role); }

export const roleLabels: Record<string, string> = { hq_admin: "总公司", hq_support: "总公司客服", branch_admin: "分公司", manager: "经理", supervisor: "主管", employee: "员工", customer: "客户", finance: "财务", auditor: "审核员" };

type MemberActivationActor = { id: string; role: string; organizationId: string | null };
type MemberActivationTarget = MemberActivationActor & { reportsToUserId: string | null; status: string };

function canManageInternalMember(actor: MemberActivationActor, member: MemberActivationTarget) {
  if (member.role === "customer" || member.id === actor.id) return false;
  if (actor.role === "hq_admin") return member.role !== "hq_admin";
  if (actor.role === "branch_admin") {
    return Boolean(actor.organizationId)
      && member.organizationId === actor.organizationId
      && ["manager", "supervisor", "employee"].includes(member.role);
  }
  return member.reportsToUserId === actor.id && childRole[actor.role] === member.role;
}

export function canManuallyActivateMember(actor: MemberActivationActor, member: MemberActivationTarget) {
  return member.status === "pending" && canManageInternalMember(actor, member);
}

export function canRestoreClosedMember(actor: MemberActivationActor, member: MemberActivationTarget) {
  return member.status === "closed" && canManageInternalMember(actor, member);
}

export function canSeeCustomer(role: string, viewerId: string, viewerOrgId: string | null, row: { branchId: string | null; managerId: string | null; supervisorId: string | null; employeeId: string | null }) {
  if (role === "hq_admin" || role === "hq_support") return true;
  if (role === "branch_admin" || role === "finance" || role === "auditor") return !!viewerOrgId && row.branchId === viewerOrgId;
  if (role === "manager") return row.managerId === viewerId;
  if (role === "supervisor") return row.supervisorId === viewerId;
  if (role === "employee") return row.employeeId === viewerId;
  return false;
}
