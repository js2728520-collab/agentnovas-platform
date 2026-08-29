import type { ConsoleNavigationGroup } from "@/packages/contracts/src/riverton-ui";

export type MaintenanceSection = "system" | "ai-strategy" | "integrations" | "configurations" | "releases" | "settings";
export type MaintenanceSystemTab = "overview" | "readiness" | "health" | "records";
export type MaintenanceAiStrategyTab = "models" | "usage";
export type MaintenanceIntegrationTab = "overview" | "sources" | "email" | "payments" | "demo";
export type MaintenanceConfigurationTab = "versions" | "platform" | "disclosures";
export type MaintenanceReleaseTab = "releases" | "safety" | "access" | "authorization-audit" | "technical-audit";

export type MaintenanceHubTab<T extends string> = {
  value: T;
  label: string;
  href: string;
  requiredPermissions?: string[];
};

export const maintenancePrimaryNavigation = [
  { label: "业务中心", items: [
    { href: "/", label: "系统运行", icon: "activity", requiredPermissions: ["maint.system_health.view", "maint.work_records.export"], activePaths: ["/readiness", "/health", "/work-records"] },
    { href: "/ai-strategy", label: "AI 与策略", icon: "cpu", requiredPermissions: ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage", "maint.ai_usage.view"], activePaths: ["/models", "/ai-usage"] },
    { href: "/integrations", label: "外部集成", icon: "plug", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage", "maint.payment_integrations.manage", "maint.demo_exchanges.view"] },
    { href: "/configurations", label: "平台配置", icon: "settings", requiredPermissions: ["maint.configuration_versions.view", "maint.feature_flags.manage", "maint.commercial_disclosures.view"], activePaths: ["/settings/disclosures"] },
    { href: "/releases", label: "发布与安全", icon: "shield", requiredPermissions: ["maint.releases.view", "maint.releases.workflow.view", "maint.emergency_pause.execute", "maint.roles.manage", "maint.roles.approve_sensitive", "maint.audit.view"], activePaths: ["/safety", "/access", "/audit"] },
  ] },
] satisfies ConsoleNavigationGroup[];

export const maintenanceSystemTabs: MaintenanceHubTab<MaintenanceSystemTab>[] = [
  { value: "overview", label: "运行概况", href: "/", requiredPermissions: ["maint.system_health.view"] },
  { value: "readiness", label: "就绪", href: "/?tab=readiness", requiredPermissions: ["maint.system_health.view"] },
  { value: "health", label: "健康", href: "/?tab=health", requiredPermissions: ["maint.system_health.view"] },
  { value: "records", label: "工作记录", href: "/?tab=records", requiredPermissions: ["maint.work_records.export"] },
];

export const maintenanceAiStrategyTabs: MaintenanceHubTab<MaintenanceAiStrategyTab>[] = [
  { value: "models", label: "模型与 Agent", href: "/ai-strategy?tab=models", requiredPermissions: ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage"] },
  { value: "usage", label: "AI 用量", href: "/ai-strategy?tab=usage", requiredPermissions: ["maint.ai_usage.view"] },
];

export const maintenanceIntegrationTabs: MaintenanceHubTab<MaintenanceIntegrationTab>[] = [
  { value: "overview", label: "集成概况", href: "/integrations", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage", "maint.payment_integrations.manage", "maint.demo_exchanges.view"] },
  { value: "sources", label: "数据与新闻", href: "/integrations?tab=sources", requiredPermissions: ["maint.system_health.view", "maint.feature_flags.manage"] },
  { value: "email", label: "邮件", href: "/integrations?tab=email", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage"] },
  { value: "payments", label: "支付", href: "/integrations?tab=payments", requiredPermissions: ["maint.system_health.view", "maint.payment_integrations.manage"] },
  { value: "demo", label: "Demo 交易所", href: "/integrations?tab=demo", requiredPermissions: ["maint.demo_exchanges.view"] },
];

export const maintenanceConfigurationTabs: MaintenanceHubTab<MaintenanceConfigurationTab>[] = [
  { value: "versions", label: "配置发布", href: "/configurations", requiredPermissions: ["maint.configuration_versions.view"] },
  { value: "platform", label: "平台与客服", href: "/configurations?tab=platform", requiredPermissions: ["maint.feature_flags.manage"] },
  { value: "disclosures", label: "版本化协议", href: "/configurations?tab=disclosures", requiredPermissions: ["maint.commercial_disclosures.view"] },
];

export const maintenanceReleaseTabs: MaintenanceHubTab<MaintenanceReleaseTab>[] = [
  { value: "releases", label: "版本与回滚", href: "/releases", requiredPermissions: ["maint.releases.view", "maint.releases.workflow.view"] },
  { value: "safety", label: "紧急停控", href: "/releases?tab=safety", requiredPermissions: ["maint.emergency_pause.execute"] },
  { value: "access", label: "访问控制", href: "/releases?tab=access", requiredPermissions: ["maint.roles.manage", "maint.roles.approve_sensitive"] },
  { value: "authorization-audit", label: "授权审计", href: "/releases?tab=authorization-audit", requiredPermissions: ["maint.audit.view", "maint.roles.manage"] },
  { value: "technical-audit", label: "技术审计", href: "/releases?tab=technical-audit", requiredPermissions: ["maint.audit.view"] },
];

function rootOf(pathname: string) {
  return pathname.split("?")[0]?.split("/").filter(Boolean)[0] ?? "overview";
}

export function resolveMaintenanceSection(pathname: string): MaintenanceSection {
  if (pathname.split("?")[0] === "/settings/disclosures") return "configurations";
  const root = rootOf(pathname);
  if (["overview", "readiness", "health", "work-records"].includes(root)) return "system";
  if (["ai-strategy", "models", "ai-usage"].includes(root)) return "ai-strategy";
  if (root === "integrations") return "integrations";
  if (root === "configurations") return "configurations";
  if (["releases", "safety", "access", "audit"].includes(root)) return "releases";
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

export function resolveMaintenanceSystemTab(requested: string | null | undefined, legacyRoot = "overview", available: Iterable<MaintenanceSystemTab> = maintenanceSystemTabs.map((tab) => tab.value)): MaintenanceSystemTab {
  const legacy = legacyRoot === "readiness" ? "readiness" : legacyRoot === "health" ? "health" : legacyRoot === "work-records" ? "records" : legacyRoot === "overview" ? "overview" : null;
  return resolveTab({ requested, allowed: ["overview", "readiness", "health", "records"], available, legacy, fallback: "overview" });
}

export function resolveMaintenanceAiStrategyTab(requested: string | null | undefined, legacyRoot = "ai-strategy", available: Iterable<MaintenanceAiStrategyTab> = maintenanceAiStrategyTabs.map((tab) => tab.value)): MaintenanceAiStrategyTab {
  const legacy = legacyRoot === "models" ? "models" : legacyRoot === "ai-usage" ? "usage" : null;
  return resolveTab({ requested, allowed: ["models", "usage"], available, legacy, fallback: "models" });
}

export function resolveMaintenanceIntegrationTab(
  requested: string | null | undefined,
  legacyRoot = "integrations",
  available: Iterable<MaintenanceIntegrationTab> = maintenanceIntegrationTabs.map((tab) => tab.value),
  legacySegments: string[] = [],
): MaintenanceIntegrationTab {
  const legacy = legacyRoot === "integrations"
    ? legacySegments[0] === "sources" ? "sources"
      : legacySegments[0] === "email" ? "email"
      : legacySegments[0] === "payments" ? "payments"
      : legacySegments[0] === "demo-exchanges" ? "demo" : "overview"
    : null;
  return resolveTab({ requested, allowed: ["overview", "sources", "email", "payments", "demo"], available, legacy, fallback: "overview" });
}

export function resolveMaintenanceConfigurationTab(requested: string | null | undefined, legacyRoot = "configurations", available: Iterable<MaintenanceConfigurationTab> = maintenanceConfigurationTabs.map((tab) => tab.value), legacySegments: string[] = []): MaintenanceConfigurationTab {
  const legacy = legacyRoot === "settings" ? (legacySegments[0] === "disclosures" ? "disclosures" : "platform") : null;
  return resolveTab({ requested, allowed: ["versions", "platform", "disclosures"], available, legacy, fallback: "versions" });
}

export function resolveMaintenanceReleaseTab(
  requested: string | null | undefined,
  legacyRoot = "releases",
  available: Iterable<MaintenanceReleaseTab> = maintenanceReleaseTabs.map((tab) => tab.value),
  legacySegments: string[] = [],
): MaintenanceReleaseTab {
  const legacy = legacyRoot === "safety" ? "safety"
    : legacyRoot === "access" ? (legacySegments[0] === "audit" ? "authorization-audit" : "access")
    : legacyRoot === "audit" ? "technical-audit" : null;
  return resolveTab({ requested, allowed: ["releases", "safety", "access", "authorization-audit", "technical-audit"], available, legacy, fallback: "releases" });
}
