"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

import { AccessDenied } from "@/packages/ui/src/page-state";
import { useAppSessionContext } from "@/packages/ui/src/app-session-context";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";
import { ConsoleHubTabs } from "@/packages/ui/src/console-hub-tabs";
import { InternalSettingsWorkspace, resolveInternalSettingsTab } from "@/packages/ui/src/internal-settings-workspace";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import {
  operationsCommercialTabs,
  operationsCustomerTabs,
  operationsDashboardTabs,
  operationsGovernanceTabs,
  operationsTradingTabs,
  resolveOperationsCommercialTab,
  resolveOperationsCustomerTab,
  resolveOperationsDashboardTab,
  resolveOperationsGovernanceTab,
  resolveOperationsSection,
  resolveOperationsTradingTab,
} from "./operations-information-architecture";

const ApprovalsWorkspace = dynamic(() => import("./approvals-workspace").then((module) => module.ApprovalsWorkspace));
const AccountsWorkspace = dynamic(() => import("./accounts-workspace").then((module) => module.AccountsWorkspace));
const CustomersWorkspace = dynamic(() => import("./customers-workspace").then((module) => module.CustomersWorkspace));
const CreditsWorkspace = dynamic(() => import("./credits-workspace").then((module) => module.CreditsWorkspace));
const InvitationsWorkspace = dynamic(() => import("./invitations-workspace").then((module) => module.InvitationsWorkspace));
const KillSwitchWorkspace = dynamic(() => import("./kill-switch-workspace").then((module) => module.KillSwitchWorkspace));
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
export default function OperationsApp({ segments }: { segments: string[] }) {
  // 会话由根 layout 的 frame 解析一次，loading / error / 未登录跳转也在那里统一处理。
  // 页面只做权限判定与工作区分发，因此这里可以安全地断言已认证。
  const session = useAppSessionContext();
  const { t } = useAppLocale();
  const searchParams = useSearchParams();
  const route = segments[0] || "overview";
  if (session.status !== "authenticated") return null;
  const permissions = session.access.permissions;
  const overview = <OperationsOverview canViewDeposits={Boolean(permissions["ops.deposits.view"])} canViewCustomers={Boolean(permissions["ops.customers.view"])} canApproveDeposits={Boolean(permissions["ops.deposits.action_approve"])} canViewTrading={Boolean(permissions["ops.trading.manage"])} />;
  const section = resolveOperationsSection(`/${segments.join("/")}`);

  if (section === "settings") {
    const tab = resolveInternalSettingsTab(searchParams.get("tab"), route);
    return <InternalSettingsWorkspace audience="operations" viewer={session.viewer} access={session.access} tab={tab} />;
  }

  if (section === "dashboard") {
    const available = operationsDashboardTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveOperationsDashboardTab(searchParams.get("tab"), route, available);
    const required = operationsDashboardTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="运营看板" active={tab} tabs={operationsDashboardTabs} permissions={permissions} />
      {tab === "overview" ? overview : tab === "targets" ? <TeamWorkspace canManage={Boolean(permissions["ops.team.manage"])} /> : <DataCenterWorkspace />}
    </>;
  }

  if (section === "customers") {
    const available = operationsCustomerTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveOperationsCustomerTab(searchParams.get("tab"), route, available);
    const required = operationsCustomerTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="客户与账户" active={tab} tabs={operationsCustomerTabs} permissions={permissions} />
      <CustomersWorkspace />
    </>;
  }

  if (section === "trading") {
    const available = operationsTradingTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveOperationsTradingTab(searchParams.get("tab"), route, available);
    const required = operationsTradingTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="交易与风控" active={tab} tabs={operationsTradingTabs} permissions={permissions} />
      {tab === "controls" ? <KillSwitchWorkspace canManage={Boolean(permissions["ops.trading.manage"])} /> : <LiveRoutingWorkspace canManage={Boolean(permissions["ops.trading.manage"])} />}
    </>;
  }

  if (section === "commercial") {
    const available = operationsCommercialTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveOperationsCommercialTab(searchParams.get("tab"), route, available);
    const required = operationsCommercialTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    const orderId = route === "membership-orders" ? segments[1] : searchParams.get("order") ?? undefined;
    const statementId = route === "performance-statements" ? segments[1] : searchParams.get("statement") ?? undefined;
    const depositId = route === "deposits" ? segments[1] : searchParams.get("deposit") ?? undefined;
    return <>
      <ConsoleHubTabs label="商业与财务" active={tab} tabs={operationsCommercialTabs} permissions={permissions} />
      {tab === "membership" ? <MembershipOrdersWorkspace orderId={orderId} viewerUserId={session.viewer.id} canRecordEvidence={Boolean(permissions["ops.membership_orders.evidence"])} canApprove={Boolean(permissions["ops.membership_orders.approve"])} />
        : tab === "credits" ? <CreditsWorkspace canAdjust={Boolean(permissions["ops.credits.adjust"])} canApprove={Boolean(permissions["ops.credits.approve"])} />
          : tab === "deposits" ? <DepositsWorkspace depositId={depositId} canRequestAction={Boolean(permissions["ops.deposits.action_request"])} />
            : tab === "ledger" ? <LedgerWorkspace />
              : tab === "statements" ? <PerformanceStatementsWorkspace statementId={statementId} canGenerate={Boolean(permissions["ops.performance_fees.generate"])} canApprove={Boolean(permissions["ops.performance_fees.approve"])} canRecordPaymentEvidence={Boolean(permissions["ops.performance_fees.payment_evidence"])} canApprovePayment={Boolean(permissions["ops.performance_fees.payment_approve"])} />
                : <FinanceWorkspace canViewLedger={Boolean(permissions["ops.ledger.view"])} canViewMembership={Boolean(permissions["ops.membership_orders.view"])} canViewPerformance={Boolean(permissions["ops.performance_fees.view"])} />}
    </>;
  }

  if (section === "governance") {
    const available = operationsGovernanceTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveOperationsGovernanceTab(searchParams.get("tab"), route, available, segments.slice(1));
    const required = operationsGovernanceTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="运营治理" active={tab} tabs={operationsGovernanceTabs} permissions={permissions} />
      {tab === "invitations" ? <InvitationsWorkspace canManage={Boolean(permissions["ops.invitations.manage"])} />
        : tab === "operators" ? <AccountsWorkspace canManage={Boolean(permissions["ops.organization.manage"])} />
          : tab === "approvals" ? <ApprovalsWorkspace canApproveDeposits={Boolean(permissions["ops.deposits.action_approve"])} canManageAccess={Boolean(permissions["ops.roles.manage"] || permissions["ops.roles.approve_sensitive"])} canApproveCredits={Boolean(permissions["ops.credits.approve"])} canManageAttributions={Boolean(permissions["ops.attributions.manage"])} canApproveMembership={Boolean(permissions["ops.membership_orders.approve"])} canApprovePerformance={Boolean(permissions["ops.performance_fees.approve"] || permissions["ops.performance_fees.payment_approve"])} canReviewOrganization={Boolean(permissions["ops.approvals.view"] || permissions["ops.approvals.decide"])} />
            : <AccessCenter appId="operations" permissions={permissions} auditOnly={tab === "audit"} />}
    </>;
  }

  return <AccessDenied message={t("当前运营页面不存在或没有访问权限。")} />;
}
