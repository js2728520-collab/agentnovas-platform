"use client";

import dynamic from "next/dynamic";

import { AccessDenied } from "@/packages/ui/src/page-state";
import { useAppSessionContext } from "@/packages/ui/src/app-session-context";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

const ApprovalsWorkspace = dynamic(() => import("./approvals-workspace").then((module) => module.ApprovalsWorkspace));
const AccountsWorkspace = dynamic(() => import("./accounts-workspace").then((module) => module.AccountsWorkspace));
const CustomersWorkspace = dynamic(() => import("./customers-workspace").then((module) => module.CustomersWorkspace));
const CreditsWorkspace = dynamic(() => import("./credits-workspace").then((module) => module.CreditsWorkspace));
const InvitationsWorkspace = dynamic(() => import("./invitations-workspace").then((module) => module.InvitationsWorkspace));
const KillSwitchWorkspace = dynamic(() => import("./kill-switch-workspace").then((module) => module.KillSwitchWorkspace));
const FollowRiskWorkspace = dynamic(() => import("./follow-risk-workspace").then((module) => module.FollowRiskWorkspace));
const LiveRoutingWorkspace = dynamic(() => import("./live-routing-workspace").then((module) => module.LiveRoutingWorkspace));
const DepositsWorkspace = dynamic(() => import("./deposits-workspace").then((module) => module.DepositsWorkspace));
const FinanceWorkspace = dynamic(() => import("./finance-workspace").then((module) => module.FinanceWorkspace));
const LedgerWorkspace = dynamic(() => import("./ledger-workspace").then((module) => module.LedgerWorkspace));
const MembershipOrdersWorkspace = dynamic(() => import("./membership-orders-workspace").then((module) => module.MembershipOrdersWorkspace));
const OperationsOverview = dynamic(() => import("./operations-overview").then((module) => module.OperationsOverview));
const PerformanceStatementsWorkspace = dynamic(() => import("./performance-statements-workspace").then((module) => module.PerformanceStatementsWorkspace));
const TeamWorkspace = dynamic(() => import("./team-workspace").then((module) => module.TeamWorkspace));
const DataCenterWorkspace = dynamic(() => import("./data-center-workspace").then((module) => module.DataCenterWorkspace));
const AccessCenter = dynamic(() => import("@/packages/ui/src/access-center").then((module) => module.AccessCenter));
const InternalAccountSecurity = dynamic(() => import("@/packages/ui/src/internal-account-security").then((module) => module.InternalAccountSecurity));


const routePermissions: Record<string, string[] | undefined> = {
  customers: ["ops.customers.view"], accounts: ["ops.organization.view"],
  team: ["ops.team.view"],
  "data-center": ["ops.customers.view"],
  "membership-orders": ["ops.membership_orders.view"],
  "performance-statements": ["ops.performance_fees.view"],
  credits: ["ops.credits.view"],
  deposits: ["ops.deposits.view"], ledger: ["ops.ledger.view"], finance: ["ops.ledger.view", "ops.membership_orders.view", "ops.performance_fees.view"],
  approvals: ["ops.approvals.view", "ops.approvals.decide", "ops.deposits.action_approve", "ops.roles.approve_sensitive", "ops.credits.approve", "ops.attributions.manage", "ops.membership_orders.approve", "ops.performance_fees.approve", "ops.performance_fees.payment_approve"],
  access: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"],
  invitations: ["ops.invitations.view", "ops.invitations.manage"],
  "kill-switches": ["ops.trading.manage"],
  "follow-risk": ["ops.follow_risk.view"],
  "live-routing": ["ops.trading.manage"],
};

export default function OperationsApp({ segments }: { segments: string[] }) {
  // 会话由根 layout 的 frame 解析一次，loading / error / 未登录跳转也在那里统一处理。
  // 页面只做权限判定与工作区分发，因此这里可以安全地断言已认证。
  const session = useAppSessionContext();
  const route = segments[0] || "overview";
  if (session.status !== "authenticated") return null;
  const required = routePermissions[route];
  if (!hasAnyPermission(session.access.permissions, required)) return <AccessDenied />;
  const permissions = session.access.permissions;
  const overview = <OperationsOverview canViewDeposits={Boolean(permissions["ops.deposits.view"])} canViewCustomers={Boolean(permissions["ops.customers.view"])} canApproveDeposits={Boolean(permissions["ops.deposits.action_approve"])} />;
  const content = route === "overview" ? overview
    : route === "account" ? <InternalAccountSecurity />
    : route === "customers" ? <CustomersWorkspace />
    : route === "accounts" ? <AccountsWorkspace canManage={Boolean(permissions["ops.organization.manage"])} />
    : route === "team" ? <TeamWorkspace canManage={Boolean(permissions["ops.team.manage"])} />
    : route === "data-center" ? <DataCenterWorkspace />
    : route === "membership-orders" ? <MembershipOrdersWorkspace
      orderId={segments[1]}
      viewerUserId={session.viewer.id}
      canRecordEvidence={Boolean(permissions["ops.membership_orders.evidence"])}
      canApprove={Boolean(permissions["ops.membership_orders.approve"])}
    />
    : route === "performance-statements" ? <PerformanceStatementsWorkspace
      statementId={segments[1]}
      canGenerate={Boolean(permissions["ops.performance_fees.generate"])}
      canApprove={Boolean(permissions["ops.performance_fees.approve"])}
      canRecordPaymentEvidence={Boolean(permissions["ops.performance_fees.payment_evidence"])}
      canApprovePayment={Boolean(permissions["ops.performance_fees.payment_approve"])}
    />
    : route === "credits" ? <CreditsWorkspace canAdjust={Boolean(permissions["ops.credits.adjust"])} canApprove={Boolean(permissions["ops.credits.approve"])} />
    : route === "deposits" ? <DepositsWorkspace depositId={segments[1]} canRequestAction={Boolean(permissions["ops.deposits.action_request"])} />
    : route === "ledger" ? <LedgerWorkspace />
    : route === "finance" ? <FinanceWorkspace canViewLedger={Boolean(permissions["ops.ledger.view"])} canViewMembership={Boolean(permissions["ops.membership_orders.view"])} canViewPerformance={Boolean(permissions["ops.performance_fees.view"])} />
    : route === "approvals" ? <ApprovalsWorkspace canApproveDeposits={Boolean(permissions["ops.deposits.action_approve"])} canManageAccess={Boolean(permissions["ops.roles.manage"] || permissions["ops.roles.approve_sensitive"])} canApproveCredits={Boolean(permissions["ops.credits.approve"])} canManageAttributions={Boolean(permissions["ops.attributions.manage"])} canApproveMembership={Boolean(permissions["ops.membership_orders.approve"])} canApprovePerformance={Boolean(permissions["ops.performance_fees.approve"] || permissions["ops.performance_fees.payment_approve"])} canReviewOrganization={Boolean(permissions["ops.approvals.view"] || permissions["ops.approvals.decide"])} />
    : route === "invitations" ? <InvitationsWorkspace canManage={Boolean(permissions["ops.invitations.manage"])} />
    : route === "kill-switches" ? <KillSwitchWorkspace canManage={Boolean(permissions["ops.trading.manage"])} />
    : route === "follow-risk" ? <FollowRiskWorkspace canManage={Boolean(permissions["ops.follow_risk.manage"])} />
    : route === "live-routing" ? <LiveRoutingWorkspace canManage={Boolean(permissions["ops.trading.manage"])} />
    : route === "access" ? <AccessCenter appId="operations" permissions={permissions} auditOnly={segments[1] === "audit"} />
    : overview;
  return content;
}
