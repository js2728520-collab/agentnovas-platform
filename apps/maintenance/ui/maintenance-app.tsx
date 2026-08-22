"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";

import { ConsoleShell } from "@/packages/ui/src/console-shell";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { hasAnyPermission, type ConsoleNavigationItem } from "@/packages/contracts/src/riverton-ui";

const workspaceLoading = () => <LoadingState label="正在加载运维模块…" />;
const EmailIntegrationWorkspace = dynamic(() => import("./email-integration-workspace").then((module) => module.EmailIntegrationWorkspace), { loading: workspaceLoading });
const DemoExchangesWorkspace = dynamic(() => import("./demo-exchanges-workspace").then((module) => module.DemoExchangesWorkspace), { loading: workspaceLoading });
const EmergencyControlWorkspace = dynamic(() => import("./emergency-control-workspace").then((module) => module.EmergencyControlWorkspace), { loading: workspaceLoading });
const IntegrationsOverview = dynamic(() => import("./integrations-overview").then((module) => module.IntegrationsOverview), { loading: workspaceLoading });
const ModelsWorkspace = dynamic(() => import("./models-workspace").then((module) => module.ModelsWorkspace), { loading: workspaceLoading });
const PaymentIntegrationWorkspace = dynamic(() => import("./payment-integration-workspace").then((module) => module.PaymentIntegrationWorkspace), { loading: workspaceLoading });
const PlatformSettingsWorkspace = dynamic(() => import("./platform-settings-workspace").then((module) => module.PlatformSettingsWorkspace), { loading: workspaceLoading });
const CommercialDisclosuresWorkspace = dynamic(() => import("./commercial-disclosures-workspace").then((module) => module.CommercialDisclosuresWorkspace), { loading: workspaceLoading });
const SystemHealthWorkspace = dynamic(() => import("./system-health-workspace").then((module) => module.SystemHealthWorkspace), { loading: workspaceLoading });
const TechnicalAuditWorkspace = dynamic(() => import("./technical-audit-workspace").then((module) => module.TechnicalAuditWorkspace), { loading: workspaceLoading });
const ReleaseManagementWorkspace = dynamic(() => import("./release-management-workspace").then((module) => module.ReleaseManagementWorkspace), { loading: workspaceLoading });
const SourceIntegrationsWorkspace = dynamic(() => import("./source-integrations-workspace").then((module) => module.SourceIntegrationsWorkspace), { loading: workspaceLoading });
const AccessCenter = dynamic(() => import("@/packages/ui/src/access-center").then((module) => module.AccessCenter), { loading: workspaceLoading });
const InternalAccountSecurity = dynamic(() => import("@/packages/ui/src/internal-account-security").then((module) => module.InternalAccountSecurity), { loading: workspaceLoading });

const navigation: ConsoleNavigationItem[] = [
  { href: "/", label: "系统概览", icon: "⌂", requiredPermissions: ["maint.system_health.view"] },
  { href: "/models", label: "模型与 Agent", icon: "模", requiredPermissions: ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage"] },
  { href: "/integrations", label: "服务集成", icon: "接", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage", "maint.payment_integrations.manage", "maint.demo_exchanges.view"] },
  { href: "/integrations/sources", label: "数据与新闻", icon: "源", requiredPermissions: ["maint.system_health.view", "maint.feature_flags.manage"] },
  { href: "/integrations/email", label: "邮件服务", icon: "邮", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage"] },
  { href: "/integrations/payments", label: "支付服务", icon: "付", requiredPermissions: ["maint.system_health.view", "maint.payment_integrations.manage"] },
  { href: "/integrations/demo-exchanges", label: "Demo 交易所", icon: "测", requiredPermissions: ["maint.demo_exchanges.view"] },
  { href: "/health", label: "系统健康", icon: "康", requiredPermissions: ["maint.system_health.view"] },
  { href: "/safety", label: "紧急暂停", icon: "停", requiredPermissions: ["maint.emergency_pause.execute"] },
  { href: "/settings", label: "平台与客服", icon: "设", requiredPermissions: ["maint.feature_flags.manage"] },
  { href: "/settings/disclosures", label: "商业披露", icon: "约", requiredPermissions: ["maint.commercial_disclosures.view"] },
  { href: "/releases", label: "版本发布", icon: "版", requiredPermissions: ["maint.releases.view"] },
  { href: "/access", label: "角色权限", icon: "权", requiredPermissions: ["maint.roles.manage", "maint.roles.approve_sensitive"] },
  { href: "/access/audit", label: "授权审计", icon: "迹", requiredPermissions: ["maint.audit.view", "maint.roles.manage"] },
  { href: "/audit", label: "技术审计", icon: "审", requiredPermissions: ["maint.audit.view"] },
  { href: "/account/security", label: "账号安全", icon: "盾" },
];

export default function MaintenanceApp({ segments }: { segments: string[] }) {
  const session = useAppSession("maintenance");
  const route = segments[0] || "overview";
  useEffect(() => {
    if (session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [session.status]);
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证运维端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  const subtype = segments[1];
  const required = route === "overview" || route === "health" ? ["maint.system_health.view"]
    : route === "models" ? ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage"]
    : route === "integrations" && subtype === "email" ? ["maint.system_health.view", "maint.email_integrations.manage"]
    : route === "integrations" && subtype === "payments" ? ["maint.system_health.view", "maint.payment_integrations.manage"]
    : route === "integrations" && subtype === "demo-exchanges" ? ["maint.demo_exchanges.view"]
    : route === "integrations" && subtype === "sources" ? ["maint.system_health.view", "maint.feature_flags.manage"]
    : route === "integrations" ? ["maint.system_health.view", "maint.email_integrations.manage", "maint.payment_integrations.manage", "maint.demo_exchanges.view"]
    : route === "safety" ? ["maint.emergency_pause.execute"]
    : route === "settings" && subtype === "disclosures" ? ["maint.commercial_disclosures.view"]
    : route === "settings" ? ["maint.feature_flags.manage"]
    : route === "releases" ? ["maint.releases.view"]
    : route === "access" && subtype === "audit" ? ["maint.audit.view", "maint.roles.manage"]
    : route === "audit" ? ["maint.audit.view"]
    : route === "access" ? ["maint.roles.manage", "maint.roles.approve_sensitive"] : undefined;
  if (!hasAnyPermission(session.access.permissions, required)) return <AccessDenied />;
  const permissions = session.access.permissions;
  const content = route === "overview" ? <SystemHealthWorkspace overview />
    : route === "account" ? <InternalAccountSecurity />
    : route === "health" ? <SystemHealthWorkspace />
    : route === "models" ? <ModelsWorkspace canManageProfiles={Boolean(permissions["maint.llm_profiles.manage"])} canManageBindings={Boolean(permissions["maint.agent_bindings.manage"])} />
    : route === "integrations" && subtype === "email" ? <EmailIntegrationWorkspace canManage={Boolean(permissions["maint.email_integrations.manage"])} />
    : route === "integrations" && subtype === "payments" ? <PaymentIntegrationWorkspace canManage={Boolean(permissions["maint.payment_integrations.manage"])} />
    : route === "integrations" && subtype === "demo-exchanges" ? <DemoExchangesWorkspace
      canVerify={Boolean(permissions["maint.demo_exchanges.verify"])}
      canManage={Boolean(permissions["maint.demo_exchanges.manage"])}
      canKill={Boolean(permissions["maint.demo_exchanges.kill"])}
    />
    : route === "integrations" && subtype === "sources" ? <SourceIntegrationsWorkspace canTest={Boolean(permissions["maint.feature_flags.manage"])} />
    : route === "integrations" ? <IntegrationsOverview
      canViewEmail={Boolean(permissions["maint.email_integrations.manage"])}
      canViewPayments={Boolean(permissions["maint.payment_integrations.manage"])}
      canViewDemo={Boolean(permissions["maint.demo_exchanges.view"])}
    />
    : route === "safety" ? <EmergencyControlWorkspace />
    : route === "settings" && subtype === "disclosures" ? <CommercialDisclosuresWorkspace currentUserId={session.viewer.id} canSubmit={Boolean(permissions["maint.commercial_disclosures.submit"])} canApprove={Boolean(permissions["maint.commercial_disclosures.approve"])} />
    : route === "settings" ? <PlatformSettingsWorkspace />
    : route === "releases" ? <ReleaseManagementWorkspace currentUserId={session.viewer.id} canManage={Boolean(permissions["maint.releases.manage"])} canApprove={Boolean(permissions["maint.releases.approve"])} />
    : route === "access" ? <AccessCenter appId="maintenance" permissions={permissions} auditOnly={subtype === "audit"} />
    : route === "audit" ? <TechnicalAuditWorkspace />
    : <SystemHealthWorkspace overview />;
  return <ConsoleShell appName="运维端" appKind="maintenance" statusText="配置密钥不会在浏览器回显" accountLabel="运维账户" navigation={navigation} viewer={session.viewer} access={session.access}>{content}</ConsoleShell>;
}
