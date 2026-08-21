"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";

import { ConsoleShell } from "@/packages/ui/src/console-shell";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { hasAnyPermission, type ConsoleNavigationItem } from "@/packages/contracts/src/riverton-ui";

const workspaceLoading = () => <LoadingState label="正在加载运营模块…" />;
const ApprovalsWorkspace = dynamic(() => import("./approvals-workspace").then((module) => module.ApprovalsWorkspace), { loading: workspaceLoading });
const CustomersWorkspace = dynamic(() => import("./customers-workspace").then((module) => module.CustomersWorkspace), { loading: workspaceLoading });
const CreditsWorkspace = dynamic(() => import("./credits-workspace").then((module) => module.CreditsWorkspace), { loading: workspaceLoading });
const DepositsWorkspace = dynamic(() => import("./deposits-workspace").then((module) => module.DepositsWorkspace), { loading: workspaceLoading });
const FinanceWorkspace = dynamic(() => import("./finance-workspace").then((module) => module.FinanceWorkspace), { loading: workspaceLoading });
const LedgerWorkspace = dynamic(() => import("./ledger-workspace").then((module) => module.LedgerWorkspace), { loading: workspaceLoading });
const MembershipOrdersWorkspace = dynamic(() => import("./membership-orders-workspace").then((module) => module.MembershipOrdersWorkspace), { loading: workspaceLoading });
const OperationsOverview = dynamic(() => import("./operations-overview").then((module) => module.OperationsOverview), { loading: workspaceLoading });
const OrganizationWorkspace = dynamic(() => import("./organization-workspace").then((module) => module.OrganizationWorkspace), { loading: workspaceLoading });
const PerformanceStatementsWorkspace = dynamic(() => import("./performance-statements-workspace").then((module) => module.PerformanceStatementsWorkspace), { loading: workspaceLoading });
const TeamWorkspace = dynamic(() => import("./team-workspace").then((module) => module.TeamWorkspace), { loading: workspaceLoading });
const DataCenterWorkspace = dynamic(() => import("./data-center-workspace").then((module) => module.DataCenterWorkspace), { loading: workspaceLoading });
const AccessCenter = dynamic(() => import("@/packages/ui/src/access-center").then((module) => module.AccessCenter), { loading: workspaceLoading });
const InternalAccountSecurity = dynamic(() => import("@/packages/ui/src/internal-account-security").then((module) => module.InternalAccountSecurity), { loading: workspaceLoading });

const navigation: ConsoleNavigationItem[] = [
  { href: "/", label: "运营概览", icon: "⌂" },
  { href: "/customers", label: "客户管理", icon: "客", requiredPermissions: ["ops.customers.view"] },
  { href: "/organization", label: "组织架构", icon: "组", requiredPermissions: ["ops.organization.view"] },
  { href: "/team", label: "团队目标", icon: "队", requiredPermissions: ["ops.team.view"] },
  { href: "/data-center", label: "数据中心", icon: "数", requiredPermissions: ["ops.customers.view"] },
  { href: "/membership-orders", label: "会员订单", icon: "会", requiredPermissions: ["ops.membership_orders.view"] },
  { href: "/performance-statements", label: "周分成", icon: "周", requiredPermissions: ["ops.performance_fees.view"] },
  { href: "/credits", label: "Credits", icon: "点", requiredPermissions: ["ops.credits.view"] },
  { href: "/deposits", label: "充值订单", icon: "充", requiredPermissions: ["ops.deposits.view"] },
  { href: "/ledger", label: "账本查询", icon: "账", requiredPermissions: ["ops.ledger.view"] },
  { href: "/finance", label: "财务结算", icon: "财", requiredPermissions: ["ops.ledger.view", "ops.membership_orders.view", "ops.performance_fees.view"] },
  { href: "/approvals", label: "审批中心", icon: "审", requiredPermissions: ["ops.approvals.view", "ops.approvals.decide", "ops.deposits.action_approve", "ops.roles.approve_sensitive", "ops.credits.approve", "ops.attributions.manage", "ops.membership_orders.approve", "ops.performance_fees.approve", "ops.performance_fees.payment_approve"] },
  { href: "/access", label: "角色权限", icon: "权", requiredPermissions: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"] },
  { href: "/access/audit", label: "授权审计", icon: "迹", requiredPermissions: ["ops.roles.manage", "ops.roles.approve_sensitive"] },
  { href: "/account/security", label: "账号安全", icon: "盾" },
];

const routePermissions: Record<string, string[] | undefined> = {
  customers: ["ops.customers.view"], organization: ["ops.organization.view"],
  team: ["ops.team.view"],
  "data-center": ["ops.customers.view"],
  "membership-orders": ["ops.membership_orders.view"],
  "performance-statements": ["ops.performance_fees.view"],
  credits: ["ops.credits.view"],
  deposits: ["ops.deposits.view"], ledger: ["ops.ledger.view"], finance: ["ops.ledger.view", "ops.membership_orders.view", "ops.performance_fees.view"],
  approvals: ["ops.approvals.view", "ops.approvals.decide", "ops.deposits.action_approve", "ops.roles.approve_sensitive", "ops.credits.approve", "ops.attributions.manage", "ops.membership_orders.approve", "ops.performance_fees.approve", "ops.performance_fees.payment_approve"],
  access: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"],
};

export default function OperationsApp({ segments }: { segments: string[] }) {
  const session = useAppSession("operations");
  const route = segments[0] || "overview";
  useEffect(() => {
    if (session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [session.status]);
  const required = routePermissions[route];
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证运营端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  if (!hasAnyPermission(session.access.permissions, required)) return <AccessDenied />;
  const permissions = session.access.permissions;
  const overview = <OperationsOverview canViewDeposits={Boolean(permissions["ops.deposits.view"])} canViewCustomers={Boolean(permissions["ops.customers.view"])} canApproveDeposits={Boolean(permissions["ops.deposits.action_approve"])} />;
  const content = route === "overview" ? overview
    : route === "account" ? <InternalAccountSecurity />
    : route === "customers" ? <CustomersWorkspace />
    : route === "organization" ? <OrganizationWorkspace canManage={Boolean(permissions["ops.organization.manage"])} />
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
    : route === "access" ? <AccessCenter appId="operations" permissions={permissions} auditOnly={segments[1] === "audit"} />
    : overview;
  return <ConsoleShell appName="运营端" appKind="operations" statusText="运营数据按权限范围展示" accountLabel="运营账户" navigation={navigation} viewer={session.viewer} access={session.access}>{content}</ConsoleShell>;
}
