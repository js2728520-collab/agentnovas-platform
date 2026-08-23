import type { ConsoleNavigationGroup } from "@/packages/contracts/src/riverton-ui";

/**
 * 运维端导航。
 *
 * 外壳渲染在根 layout 里（跨导航保留），所以导航配置必须独立于页面模块，
 * 否则 layout 会把整个页面模块拖进公共包。
 */
export const navigation: ConsoleNavigationGroup[] = [
  { label: "概览", items: [
    { href: "/", label: "系统概览", icon: "dashboard", requiredPermissions: ["maint.system_health.view"] },
    { href: "/readiness", label: "开服就绪清单", icon: "check-square", requiredPermissions: ["maint.system_health.view"] },
    { href: "/health", label: "系统健康", icon: "activity", requiredPermissions: ["maint.system_health.view"] },
  ] },
  { label: "模型与集成", items: [
    { href: "/models", label: "模型与 Agent", icon: "cpu", requiredPermissions: ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage"] },
    { href: "/integrations", label: "服务集成", icon: "plug", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage", "maint.payment_integrations.manage", "maint.demo_exchanges.view"] },
    { href: "/integrations/sources", label: "数据与新闻", icon: "database", requiredPermissions: ["maint.system_health.view", "maint.feature_flags.manage"] },
    { href: "/integrations/email", label: "邮件服务", icon: "inbox", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage"] },
    { href: "/integrations/payments", label: "支付服务", icon: "wallet", requiredPermissions: ["maint.system_health.view", "maint.payment_integrations.manage"] },
    { href: "/integrations/demo-exchanges", label: "Demo 交易所", icon: "store", requiredPermissions: ["maint.demo_exchanges.view"] },
  ] },
  { label: "平台", items: [
    { href: "/safety", label: "紧急暂停", icon: "pause", requiredPermissions: ["maint.emergency_pause.execute"] },
    { href: "/settings", label: "平台与客服", icon: "settings", requiredPermissions: ["maint.feature_flags.manage"] },
    { href: "/settings/disclosures", label: "商业披露", icon: "file", requiredPermissions: ["maint.commercial_disclosures.view"] },
    { href: "/configurations", label: "配置发布", icon: "tag", requiredPermissions: ["maint.configuration_versions.view"] },
    { href: "/releases", label: "版本发布", icon: "tag", requiredPermissions: ["maint.releases.view"] },
  ] },
  { label: "账号", items: [
    { href: "/access", label: "角色权限", icon: "key", requiredPermissions: ["maint.roles.manage", "maint.roles.approve_sensitive"] },
    { href: "/access/audit", label: "授权审计", icon: "audit", requiredPermissions: ["maint.audit.view", "maint.roles.manage"] },
    { href: "/audit", label: "技术审计", icon: "check-square", requiredPermissions: ["maint.audit.view"] },
    { href: "/account/security", label: "账号安全", icon: "shield" },
  ] },
];
