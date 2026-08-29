import type { ConsoleNavigationGroup } from "@/packages/contracts/src/riverton-ui";

export type OperationsSection = "dashboard" | "customers" | "trading" | "commercial" | "governance" | "settings";
export type OperationsDashboardTab = "overview" | "targets" | "analytics";
export type OperationsCustomerTab = "customers";
export type OperationsTradingTab = "controls" | "routing";
export type OperationsCommercialTab = "membership" | "credits" | "deposits" | "ledger" | "statements" | "finance";
export type OperationsGovernanceTab = "invitations" | "operators" | "approvals" | "access" | "audit";

export type OperationsHubTab<T extends string> = {
  value: T;
  label: string;
  href: string;
  requiredPermissions?: string[];
};

export const operationsPrimaryNavigation = [
  { label: "业务中心", items: [
    { href: "/", label: "运营看板", icon: "dashboard", activePaths: ["/team", "/data-center"] },
    { href: "/customers", label: "客户与账户", icon: "users", requiredPermissions: ["ops.customers.view"] },
    { href: "/trading-operations", label: "交易与风控", icon: "shield", requiredPermissions: ["ops.trading.manage"], activePaths: ["/kill-switches", "/live-routing"] },
    { href: "/commercial", label: "商业与财务", icon: "calculator", requiredPermissions: ["ops.membership_orders.view", "ops.performance_fees.view", "ops.credits.view", "ops.deposits.view", "ops.ledger.view"], activePaths: ["/membership-orders", "/performance-statements", "/credits", "/deposits", "/ledger", "/finance"] },
    { href: "/governance", label: "运营治理", icon: "key", requiredPermissions: ["ops.invitations.view", "ops.invitations.manage", "ops.organization.view", "ops.approvals.view", "ops.approvals.decide", "ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"], activePaths: ["/invitations", "/accounts", "/approvals", "/access"] },
  ] },
] satisfies ConsoleNavigationGroup[];

export const operationsDashboardTabs: OperationsHubTab<OperationsDashboardTab>[] = [
  { value: "overview", label: "核心概况", href: "/" },
  { value: "targets", label: "目标进度", href: "/?tab=targets", requiredPermissions: ["ops.team.view"] },
  { value: "analytics", label: "业务分析", href: "/?tab=analytics", requiredPermissions: ["ops.customers.view"] },
];

export const operationsCustomerTabs: OperationsHubTab<OperationsCustomerTab>[] = [
  { value: "customers", label: "客户", href: "/customers" , requiredPermissions: ["ops.customers.view"] },
];

export const operationsTradingTabs: OperationsHubTab<OperationsTradingTab>[] = [
  { value: "controls", label: "交易停控", href: "/trading-operations?tab=controls", requiredPermissions: ["ops.trading.manage"] },
  { value: "routing", label: "实盘准备度", href: "/trading-operations?tab=routing", requiredPermissions: ["ops.trading.manage"] },
];

export const operationsCommercialTabs: OperationsHubTab<OperationsCommercialTab>[] = [
  { value: "membership", label: "会员", href: "/commercial?tab=membership", requiredPermissions: ["ops.membership_orders.view"] },
  { value: "credits", label: "Credits", href: "/commercial?tab=credits", requiredPermissions: ["ops.credits.view"] },
  { value: "deposits", label: "充值", href: "/commercial?tab=deposits", requiredPermissions: ["ops.deposits.view"] },
  { value: "ledger", label: "账本", href: "/commercial?tab=ledger", requiredPermissions: ["ops.ledger.view"] },
  { value: "statements", label: "业绩报表", href: "/commercial?tab=statements", requiredPermissions: ["ops.performance_fees.view"] },
  { value: "finance", label: "财务汇总", href: "/commercial?tab=finance", requiredPermissions: ["ops.ledger.view", "ops.membership_orders.view", "ops.performance_fees.view"] },
];

export const operationsGovernanceTabs: OperationsHubTab<OperationsGovernanceTab>[] = [
  { value: "invitations", label: "注册链接", href: "/governance?tab=invitations", requiredPermissions: ["ops.invitations.view", "ops.invitations.manage"] },
  { value: "operators", label: "运营账号", href: "/governance?tab=operators", requiredPermissions: ["ops.organization.view"] },
  { value: "approvals", label: "审批", href: "/governance?tab=approvals", requiredPermissions: ["ops.approvals.view", "ops.approvals.decide", "ops.deposits.action_approve", "ops.roles.approve_sensitive", "ops.credits.approve", "ops.attributions.manage", "ops.membership_orders.approve", "ops.performance_fees.approve", "ops.performance_fees.payment_approve"] },
  { value: "access", label: "角色权限", href: "/governance?tab=access", requiredPermissions: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"] },
  { value: "audit", label: "授权审计", href: "/governance?tab=audit", requiredPermissions: ["ops.roles.manage", "ops.roles.approve_sensitive"] },
];

function rootOf(pathname: string) {
  return pathname.split("?")[0]?.split("/").filter(Boolean)[0] ?? "overview";
}

export function resolveOperationsSection(pathname: string): OperationsSection {
  const root = rootOf(pathname);
  if (["overview", "team", "data-center"].includes(root)) return "dashboard";
  if (root === "customers") return "customers";
  if (["trading-operations", "kill-switches", "live-routing"].includes(root)) return "trading";
  if (["commercial", "membership-orders", "performance-statements", "credits", "deposits", "ledger", "finance"].includes(root)) return "commercial";
  if (["governance", "invitations", "accounts", "approvals", "access"].includes(root)) return "governance";
  return "settings";
}

function resolveTab<T extends string>(input: {
  requested: string | null | undefined;
  allowed: readonly T[];
  available: Iterable<T>;
  legacy: T | null;
  fallback: T;
}): T {
  const allowed = new Set<string>(input.allowed);
  const available = new Set<T>(input.available);
  if (typeof input.requested === "string" && allowed.has(input.requested) && available.has(input.requested as T)) return input.requested as T;
  if (input.legacy) return input.legacy;
  return input.allowed.find((tab) => available.has(tab)) ?? input.fallback;
}

export function resolveOperationsDashboardTab(requested: string | null | undefined, legacyRoot = "overview", available: Iterable<OperationsDashboardTab> = operationsDashboardTabs.map((tab) => tab.value)): OperationsDashboardTab {
  const legacy = legacyRoot === "team" ? "targets" : legacyRoot === "data-center" ? "analytics" : legacyRoot === "overview" ? "overview" : null;
  return resolveTab({ requested, allowed: ["overview", "targets", "analytics"], available, legacy, fallback: "overview" });
}

export function resolveOperationsCustomerTab(requested: string | null | undefined, legacyRoot = "customers", available: Iterable<OperationsCustomerTab> = operationsCustomerTabs.map((tab) => tab.value)): OperationsCustomerTab {
  return resolveTab({ requested, allowed: ["customers"], available, legacy: legacyRoot === "customers" ? "customers" : null, fallback: "customers" });
}

export function resolveOperationsTradingTab(requested: string | null | undefined, legacyRoot = "trading-operations", available: Iterable<OperationsTradingTab> = operationsTradingTabs.map((tab) => tab.value)): OperationsTradingTab {
  const legacy = legacyRoot === "kill-switches" ? "controls" : legacyRoot === "live-routing" ? "routing" : null;
  return resolveTab({ requested, allowed: ["controls", "routing"], available, legacy, fallback: "controls" });
}

export function resolveOperationsCommercialTab(requested: string | null | undefined, legacyRoot = "commercial", available: Iterable<OperationsCommercialTab> = operationsCommercialTabs.map((tab) => tab.value)): OperationsCommercialTab {
  const legacy = legacyRoot === "membership-orders" ? "membership"
    : legacyRoot === "credits" ? "credits"
    : legacyRoot === "deposits" ? "deposits"
    : legacyRoot === "ledger" ? "ledger"
    : legacyRoot === "performance-statements" ? "statements"
    : legacyRoot === "finance" ? "finance" : null;
  return resolveTab({ requested, allowed: ["membership", "credits", "deposits", "ledger", "statements", "finance"], available, legacy, fallback: "membership" });
}

export function resolveOperationsGovernanceTab(
  requested: string | null | undefined,
  legacyRoot = "governance",
  available: Iterable<OperationsGovernanceTab> = operationsGovernanceTabs.map((tab) => tab.value),
  legacySegments: string[] = [],
): OperationsGovernanceTab {
  const legacy = legacyRoot === "invitations" ? "invitations"
    : legacyRoot === "accounts" ? "operators"
    : legacyRoot === "approvals" ? "approvals"
    : legacyRoot === "access" ? (legacySegments[0] === "audit" ? "audit" : "access") : null;
  return resolveTab({ requested, allowed: ["invitations", "operators", "approvals", "access", "audit"], available, legacy, fallback: "invitations" });
}
