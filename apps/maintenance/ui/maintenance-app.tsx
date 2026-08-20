"use client";

import { useEffect } from "react";

import { EmailIntegrationWorkspace } from "./email-integration-workspace";
import { DemoExchangesWorkspace } from "./demo-exchanges-workspace";
import { EmergencyControlWorkspace } from "./emergency-control-workspace";
import { IntegrationsOverview } from "./integrations-overview";
import { ModelsWorkspace } from "./models-workspace";
import { PaymentIntegrationWorkspace } from "./payment-integration-workspace";
import { PlatformSettingsWorkspace } from "./platform-settings-workspace";
import { SystemHealthWorkspace } from "./system-health-workspace";
import { AccessCenter } from "@/packages/ui/src/access-center";
import { AppLogin } from "@/packages/ui/src/app-login";
import { ConsoleShell } from "@/packages/ui/src/console-shell";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { hasAnyPermission, type ConsoleNavigationItem } from "@/packages/contracts/src/riverton-ui";

const navigation: ConsoleNavigationItem[] = [
  { href: "/", label: "系统概览", icon: "⌂", requiredPermissions: ["maint.system_health.view"] },
  { href: "/models", label: "模型与 Agent", icon: "模", requiredPermissions: ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage"] },
  { href: "/integrations", label: "服务集成", icon: "接", requiredPermissions: ["maint.system_health.view"] },
  { href: "/integrations/email", label: "邮件服务", icon: "邮", requiredPermissions: ["maint.system_health.view", "maint.email_integrations.manage"] },
  { href: "/integrations/payments", label: "支付服务", icon: "付", requiredPermissions: ["maint.system_health.view", "maint.payment_integrations.manage"] },
  { href: "/integrations/demo-exchanges", label: "Demo 交易所", icon: "测", requiredPermissions: ["maint.demo_exchanges.view"] },
  { href: "/health", label: "系统健康", icon: "康", requiredPermissions: ["maint.system_health.view"] },
  { href: "/safety", label: "紧急暂停", icon: "停", requiredPermissions: ["maint.emergency_pause.execute"] },
  { href: "/settings", label: "平台与客服", icon: "设", requiredPermissions: ["maint.feature_flags.manage"] },
  { href: "/access", label: "角色权限", icon: "权", requiredPermissions: ["maint.roles.manage", "maint.roles.approve_sensitive"] },
  { href: "/access/audit", label: "授权审计", icon: "迹", requiredPermissions: ["maint.audit.view", "maint.roles.manage"] },
];

export default function MaintenanceApp({ segments }: { segments: string[] }) {
  const session = useAppSession("maintenance");
  const route = segments[0] || "overview";
  const isLogin = route === "login";
  useEffect(() => {
    if (!isLogin && session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [isLogin, session.status]);
  if (isLogin) return <AppLogin audience="maintenance" title="Riverton 运维端" description="模型、集成、安全、审计和系统健康工作台。" allowRegistration={false} />;
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证运维端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  const subtype = segments[1];
  const required = route === "overview" || route === "health" ? ["maint.system_health.view"]
    : route === "models" ? ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage"]
    : route === "integrations" && subtype === "email" ? ["maint.system_health.view", "maint.email_integrations.manage"]
    : route === "integrations" && subtype === "payments" ? ["maint.system_health.view", "maint.payment_integrations.manage"]
    : route === "integrations" && subtype === "demo-exchanges" ? ["maint.demo_exchanges.view"]
    : route === "integrations" ? ["maint.system_health.view", "maint.email_integrations.manage", "maint.payment_integrations.manage", "maint.demo_exchanges.view"]
    : route === "safety" ? ["maint.emergency_pause.execute"]
    : route === "settings" ? ["maint.feature_flags.manage"]
    : route === "access" && subtype === "audit" ? ["maint.audit.view", "maint.roles.manage"]
    : route === "access" ? ["maint.roles.manage", "maint.roles.approve_sensitive"] : undefined;
  if (!hasAnyPermission(session.access.permissions, required)) return <AccessDenied />;
  const permissions = session.access.permissions;
  const content = route === "overview" ? <SystemHealthWorkspace overview />
    : route === "health" ? <SystemHealthWorkspace />
    : route === "models" ? <ModelsWorkspace canManageProfiles={Boolean(permissions["maint.llm_profiles.manage"])} canManageBindings={Boolean(permissions["maint.agent_bindings.manage"])} />
    : route === "integrations" && subtype === "email" ? <EmailIntegrationWorkspace canManage={Boolean(permissions["maint.email_integrations.manage"])} />
    : route === "integrations" && subtype === "payments" ? <PaymentIntegrationWorkspace canManage={Boolean(permissions["maint.payment_integrations.manage"])} />
    : route === "integrations" && subtype === "demo-exchanges" ? <DemoExchangesWorkspace
      canVerify={Boolean(permissions["maint.demo_exchanges.verify"])}
      canManage={Boolean(permissions["maint.demo_exchanges.manage"])}
      canKill={Boolean(permissions["maint.demo_exchanges.kill"])}
    />
    : route === "integrations" ? <IntegrationsOverview canViewDemo={Boolean(permissions["maint.demo_exchanges.view"])} />
    : route === "safety" ? <EmergencyControlWorkspace />
    : route === "settings" ? <PlatformSettingsWorkspace />
    : route === "access" ? <AccessCenter appId="maintenance" permissions={permissions} auditOnly={subtype === "audit"} />
    : <SystemHealthWorkspace overview />;
  return <ConsoleShell appName="运维端" appKind="maintenance" navigation={navigation} viewer={session.viewer} access={session.access}>{content}</ConsoleShell>;
}
