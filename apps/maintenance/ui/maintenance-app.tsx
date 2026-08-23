"use client";

import dynamic from "next/dynamic";

import { AccessDenied } from "@/packages/ui/src/page-state";
import { useAppSessionContext } from "@/packages/ui/src/app-session-context";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

const EmailIntegrationWorkspace = dynamic(() => import("./email-integration-workspace").then((module) => module.EmailIntegrationWorkspace));
const DemoExchangesWorkspace = dynamic(() => import("./demo-exchanges-workspace").then((module) => module.DemoExchangesWorkspace));
const EmergencyControlWorkspace = dynamic(() => import("./emergency-control-workspace").then((module) => module.EmergencyControlWorkspace));
const IntegrationsOverview = dynamic(() => import("./integrations-overview").then((module) => module.IntegrationsOverview));
const ModelsWorkspace = dynamic(() => import("./models-workspace").then((module) => module.ModelsWorkspace));
const PaymentIntegrationWorkspace = dynamic(() => import("./payment-integration-workspace").then((module) => module.PaymentIntegrationWorkspace));
const PlatformSettingsWorkspace = dynamic(() => import("./platform-settings-workspace").then((module) => module.PlatformSettingsWorkspace));
const CommercialDisclosuresWorkspace = dynamic(() => import("./commercial-disclosures-workspace").then((module) => module.CommercialDisclosuresWorkspace));
const SystemHealthWorkspace = dynamic(() => import("./system-health-workspace").then((module) => module.SystemHealthWorkspace));
const ReadinessWorkspace = dynamic(() => import("./readiness-workspace").then((module) => module.ReadinessWorkspace));
const TechnicalAuditWorkspace = dynamic(() => import("./technical-audit-workspace").then((module) => module.TechnicalAuditWorkspace));
const ReleaseManagementWorkspace = dynamic(() => import("./release-management-workspace").then((module) => module.ReleaseManagementWorkspace));
const ConfigurationVersionsWorkspace = dynamic(() => import("./configuration-versions-workspace").then((module) => module.ConfigurationVersionsWorkspace));
const SourceIntegrationsWorkspace = dynamic(() => import("./source-integrations-workspace").then((module) => module.SourceIntegrationsWorkspace));
const AiUsageWorkspace = dynamic(() => import("./ai-usage-workspace").then((module) => module.AiUsageWorkspace));
const AccessCenter = dynamic(() => import("@/packages/ui/src/access-center").then((module) => module.AccessCenter));
const InternalAccountSecurity = dynamic(() => import("@/packages/ui/src/internal-account-security").then((module) => module.InternalAccountSecurity));


export default function MaintenanceApp({ segments }: { segments: string[] }) {
  // 会话由根 layout 的 frame 解析一次，loading / error / 未登录跳转也在那里统一处理。
  // 页面只做权限判定与工作区分发，因此这里可以安全地断言已认证。
  const session = useAppSessionContext();
  const route = segments[0] || "overview";
  if (session.status !== "authenticated") return null;
  const subtype = segments[1];
  const required = route === "overview" || route === "health" || route === "readiness" ? ["maint.system_health.view"]
    : route === "ai-usage" ? ["maint.ai_usage.view"]
    : route === "models" ? ["maint.system_health.view", "maint.llm_profiles.manage", "maint.agent_bindings.manage"]
    : route === "integrations" && subtype === "email" ? ["maint.system_health.view", "maint.email_integrations.manage"]
    : route === "integrations" && subtype === "payments" ? ["maint.system_health.view", "maint.payment_integrations.manage"]
    : route === "integrations" && subtype === "demo-exchanges" ? ["maint.demo_exchanges.view"]
    : route === "integrations" && subtype === "sources" ? ["maint.system_health.view", "maint.feature_flags.manage"]
    : route === "integrations" ? ["maint.system_health.view", "maint.email_integrations.manage", "maint.payment_integrations.manage", "maint.demo_exchanges.view"]
    : route === "safety" ? ["maint.emergency_pause.execute"]
    : route === "settings" && subtype === "disclosures" ? ["maint.commercial_disclosures.view"]
    : route === "settings" ? ["maint.feature_flags.manage"]
    : route === "configurations" ? ["maint.configuration_versions.view"]
    : route === "releases" ? ["maint.releases.view"]
    : route === "access" && subtype === "audit" ? ["maint.audit.view", "maint.roles.manage"]
    : route === "audit" ? ["maint.audit.view"]
    : route === "access" ? ["maint.roles.manage", "maint.roles.approve_sensitive"] : undefined;
  if (!hasAnyPermission(session.access.permissions, required)) return <AccessDenied />;
  const permissions = session.access.permissions;
  const content = route === "overview" ? <SystemHealthWorkspace overview />
    : route === "account" ? <InternalAccountSecurity />
    : route === "readiness" ? <ReadinessWorkspace />
    : route === "health" ? <SystemHealthWorkspace />
    : route === "ai-usage" ? <AiUsageWorkspace />
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
    : route === "configurations" ? <ConfigurationVersionsWorkspace currentUserId={session.viewer.id} canManage={Boolean(permissions["maint.configuration_versions.manage"])} canApprove={Boolean(permissions["maint.configuration_versions.approve"])} canActivate={Boolean(permissions["maint.configuration_versions.activate"])} />
    : route === "releases" ? <ReleaseManagementWorkspace currentUserId={session.viewer.id} canManage={Boolean(permissions["maint.releases.manage"])} canApprove={Boolean(permissions["maint.releases.approve"])} />
    : route === "access" ? <AccessCenter appId="maintenance" permissions={permissions} auditOnly={subtype === "audit"} />
    : route === "audit" ? <TechnicalAuditWorkspace />
    : <SystemHealthWorkspace overview />;
  return content;
}
