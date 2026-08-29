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
  maintenanceAiStrategyTabs,
  maintenanceConfigurationTabs,
  maintenanceIntegrationTabs,
  maintenanceReleaseTabs,
  maintenanceSystemTabs,
  resolveMaintenanceAiStrategyTab,
  resolveMaintenanceConfigurationTab,
  resolveMaintenanceIntegrationTab,
  resolveMaintenanceReleaseTab,
  resolveMaintenanceSection,
  resolveMaintenanceSystemTab,
} from "./maintenance-information-architecture";

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
const WorkRecordExportWorkspace = dynamic(() => import("./work-record-export-workspace").then((module) => module.WorkRecordExportWorkspace));
const SystemOverviewWorkspace = dynamic(() => import("./system-overview-workspace").then((module) => module.SystemOverviewWorkspace));
const AccessCenter = dynamic(() => import("@/packages/ui/src/access-center").then((module) => module.AccessCenter));
export default function MaintenanceApp({ segments }: { segments: string[] }) {
  // 会话由根 layout 的 frame 解析一次，loading / error / 未登录跳转也在那里统一处理。
  // 页面只做权限判定与工作区分发，因此这里可以安全地断言已认证。
  const session = useAppSessionContext();
  const { t } = useAppLocale();
  const searchParams = useSearchParams();
  const route = segments[0] || "overview";
  if (session.status !== "authenticated") return null;
  const permissions = session.access.permissions;
  const section = route === "settings" && segments[1] === "disclosures"
    ? "configurations"
    : resolveMaintenanceSection(`/${segments.join("/")}`);

  if (section === "settings") {
    const tab = resolveInternalSettingsTab(searchParams.get("tab"), route);
    return <InternalSettingsWorkspace audience="maintenance" viewer={session.viewer} access={session.access} tab={tab} />;
  }

  if (section === "system") {
    const available = maintenanceSystemTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveMaintenanceSystemTab(searchParams.get("tab"), route, available);
    const required = maintenanceSystemTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="系统运行" active={tab} tabs={maintenanceSystemTabs} permissions={permissions} />
      {tab === "overview" ? <SystemOverviewWorkspace canViewAudit={Boolean(permissions["maint.audit.view"])} />
        : tab === "readiness" ? <ReadinessWorkspace />
          : tab === "health" ? <SystemHealthWorkspace /> : <WorkRecordExportWorkspace />}
    </>;
  }

  if (section === "ai-strategy") {
    const available = maintenanceAiStrategyTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveMaintenanceAiStrategyTab(searchParams.get("tab"), route, available);
    const required = maintenanceAiStrategyTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="AI 与策略" active={tab} tabs={maintenanceAiStrategyTabs} permissions={permissions} />
      {tab === "models" ? <ModelsWorkspace canManageProfiles={Boolean(permissions["maint.llm_profiles.manage"])} canManageBindings={Boolean(permissions["maint.agent_bindings.manage"])} /> : <AiUsageWorkspace />}
    </>;
  }

  if (section === "integrations") {
    const available = maintenanceIntegrationTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveMaintenanceIntegrationTab(searchParams.get("tab"), route, available, segments.slice(1));
    const required = maintenanceIntegrationTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="外部集成" active={tab} tabs={maintenanceIntegrationTabs} permissions={permissions} />
      {tab === "overview" ? <IntegrationsOverview canViewEmail={Boolean(permissions["maint.email_integrations.manage"])} canViewPayments={Boolean(permissions["maint.payment_integrations.manage"])} canViewDemo={Boolean(permissions["maint.demo_exchanges.view"])} />
        : tab === "sources" ? <SourceIntegrationsWorkspace canTest={Boolean(permissions["maint.feature_flags.manage"])} />
          : tab === "email" ? <EmailIntegrationWorkspace canManage={Boolean(permissions["maint.email_integrations.manage"])} />
            : tab === "payments" ? <PaymentIntegrationWorkspace canManage={Boolean(permissions["maint.payment_integrations.manage"])} />
              : <DemoExchangesWorkspace canVerify={Boolean(permissions["maint.demo_exchanges.verify"])} canManage={Boolean(permissions["maint.demo_exchanges.manage"])} canKill={Boolean(permissions["maint.demo_exchanges.kill"])} />}
    </>;
  }

  if (section === "configurations") {
    const available = maintenanceConfigurationTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveMaintenanceConfigurationTab(searchParams.get("tab"), route, available, segments.slice(1));
    const required = maintenanceConfigurationTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="平台配置" active={tab} tabs={maintenanceConfigurationTabs} permissions={permissions} />
      {tab === "versions" ? <ConfigurationVersionsWorkspace currentUserId={session.viewer.id} canManage={Boolean(permissions["maint.configuration_versions.manage"])} canApprove={Boolean(permissions["maint.configuration_versions.approve"])} canActivate={Boolean(permissions["maint.configuration_versions.activate"])} />
        : tab === "platform" ? <PlatformSettingsWorkspace />
          : <CommercialDisclosuresWorkspace currentUserId={session.viewer.id} canSubmit={Boolean(permissions["maint.commercial_disclosures.submit"])} canApprove={Boolean(permissions["maint.commercial_disclosures.approve"])} />}
    </>;
  }

  if (section === "releases") {
    const available = maintenanceReleaseTabs.filter((tab) => hasAnyPermission(permissions, tab.requiredPermissions)).map((tab) => tab.value);
    const tab = resolveMaintenanceReleaseTab(searchParams.get("tab"), route, available, segments.slice(1));
    const required = maintenanceReleaseTabs.find((item) => item.value === tab)?.requiredPermissions;
    if (!hasAnyPermission(permissions, required)) return <AccessDenied />;
    return <>
      <ConsoleHubTabs label="发布与安全" active={tab} tabs={maintenanceReleaseTabs} permissions={permissions} />
      {tab === "releases" ? <ReleaseManagementWorkspace currentUserId={session.viewer.id} canManage={Boolean(permissions["maint.releases.manage"])} canApprove={Boolean(permissions["maint.releases.approve"])} canViewEvidence={Boolean(permissions["maint.releases.view"])} />
        : tab === "safety" ? <EmergencyControlWorkspace />
          : tab === "technical-audit" ? <TechnicalAuditWorkspace />
            : <AccessCenter appId="maintenance" permissions={permissions} auditOnly={tab === "authorization-audit"} />}
    </>;
  }

  return <AccessDenied message={t("当前运维页面不存在或没有访问权限。")} />;
}
