"use client";

import { useEffect } from "react";

import { ApprovalsWorkspace } from "./approvals-workspace";
import { CustomersWorkspace } from "./customers-workspace";
import { DepositsWorkspace } from "./deposits-workspace";
import { FinanceWorkspace } from "./finance-workspace";
import { LedgerWorkspace } from "./ledger-workspace";
import { OperationsOverview } from "./operations-overview";
import { OrganizationWorkspace } from "./organization-workspace";
import { AppLogin } from "@/packages/ui/src/app-login";
import { AccessCenter } from "@/packages/ui/src/access-center";
import { ConsoleShell } from "@/packages/ui/src/console-shell";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { hasAnyPermission, type ConsoleNavigationItem } from "@/packages/contracts/src/riverton-ui";

const navigation: ConsoleNavigationItem[] = [
  { href: "/", label: "运营概览", icon: "⌂" },
  { href: "/customers", label: "客户管理", icon: "客", requiredPermissions: ["ops.customers.view"] },
  { href: "/organization", label: "组织架构", icon: "组", requiredPermissions: ["ops.customers.view", "ops.roles.manage"] },
  { href: "/deposits", label: "充值订单", icon: "充", requiredPermissions: ["ops.deposits.view"] },
  { href: "/ledger", label: "账本查询", icon: "账", requiredPermissions: ["ops.ledger.view"] },
  { href: "/finance", label: "财务结算", icon: "财", requiredPermissions: ["ops.ledger.view"] },
  { href: "/approvals", label: "审批中心", icon: "审", requiredPermissions: ["ops.deposits.action_approve", "ops.roles.approve_sensitive"] },
  { href: "/access", label: "角色权限", icon: "权", requiredPermissions: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"] },
  { href: "/access/audit", label: "授权审计", icon: "迹", requiredPermissions: ["ops.roles.manage", "ops.roles.approve_sensitive"] },
];

const routePermissions: Record<string, string[] | undefined> = {
  customers: ["ops.customers.view"], organization: ["ops.customers.view", "ops.roles.manage"],
  deposits: ["ops.deposits.view"], ledger: ["ops.ledger.view"], finance: ["ops.ledger.view"],
  approvals: ["ops.deposits.action_approve", "ops.roles.approve_sensitive"],
  access: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"],
};

export default function OperationsApp({ segments }: { segments: string[] }) {
  const session = useAppSession("operations");
  const route = segments[0] || "overview";
  const isLogin = route === "login";
  useEffect(() => {
    if (!isLogin && session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [isLogin, session.status]);
  const required = routePermissions[route];
  if (isLogin) return <AppLogin audience="operations" title="Riverton 运营端" description="客户、充值、账务、财务和审批工作台。" allowRegistration={false} />;
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证运营端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  if (!hasAnyPermission(session.access.permissions, required)) return <AccessDenied />;
  const permissions = session.access.permissions;
  const overview = <OperationsOverview canViewDeposits={Boolean(permissions["ops.deposits.view"])} canViewCustomers={Boolean(permissions["ops.customers.view"])} canApproveDeposits={Boolean(permissions["ops.deposits.action_approve"])} />;
  const content = route === "overview" ? overview
    : route === "customers" ? <CustomersWorkspace />
    : route === "organization" ? <OrganizationWorkspace />
    : route === "deposits" ? <DepositsWorkspace depositId={segments[1]} canRequestAction={Boolean(permissions["ops.deposits.action_request"])} />
    : route === "ledger" ? <LedgerWorkspace />
    : route === "finance" ? <FinanceWorkspace canRequestAdjustment={Boolean(permissions["ops.reconciliation.run"])} />
    : route === "approvals" ? <ApprovalsWorkspace canApproveDeposits={Boolean(permissions["ops.deposits.action_approve"])} canManageAccess={Boolean(permissions["ops.roles.manage"] || permissions["ops.roles.approve_sensitive"])} />
    : route === "access" ? <AccessCenter appId="operations" permissions={permissions} auditOnly={segments[1] === "audit"} />
    : overview;
  return <ConsoleShell appName="运营端" appKind="operations" navigation={navigation} viewer={session.viewer} access={session.access}>{content}</ConsoleShell>;
}
