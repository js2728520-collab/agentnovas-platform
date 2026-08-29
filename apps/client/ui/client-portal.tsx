"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

import { AccessDenied } from "@/packages/ui/src/page-state";
import { useAppSessionContext } from "@/packages/ui/src/app-session-context";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";
import { AppPreferenceSettings } from "@/packages/ui/src/app-preference-settings";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import { ClientHomeWorkspace } from "./client-home-workspace";
import { ClientHubTabs } from "./client-hub-tabs";
import { StrategyCenterUnavailable } from "./strategy-center-unavailable";
import {
  resolveAccountCenterTab,
  resolveSettingsTab,
  resolveTradingTab,
} from "./client-information-architecture";

const CreditWorkspace = dynamic(() => import("./credit-workspace").then((module) => module.CreditWorkspace));
const DepositWorkspace = dynamic(() => import("./deposit-workspace").then((module) => module.DepositWorkspace));
const LegalConsentExperience = dynamic(() => import("./legal-consent-experience").then((module) => module.LegalConsentExperience));
const PublicLegalPage = dynamic(() => import("./public-legal-page").then((module) => module.PublicLegalPage));
const MembershipExperience = dynamic(() => import("./membership-experience"));
const AiAssistantChat = dynamic(() => import("./ai-assistant-chat"));
const DecisionHall = dynamic(() => import("./decision-hall"));
const WorkRecordsWorkspace = dynamic(() => import("./work-records-workspace").then((module) => module.WorkRecordsWorkspace));
const DecisionMeeting = dynamic(() => import("./decision-hall").then((module) => module.DecisionMeeting));
const LiveMarket = dynamic(() => import("./live-market"));
const PerformanceStatementsWorkspace = dynamic(() => import("./performance-statements-workspace").then((module) => module.PerformanceStatementsWorkspace));
const TradingExperience = dynamic(() => import("./trading-experience"));
const WalletWorkspace = dynamic(() => import("./wallet-workspace").then((module) => module.WalletWorkspace));
const AccountSecurityWorkspace = dynamic(() => import("./account-security-workspace").then((module) => module.AccountSecurityWorkspace));
const SupportWorkspace = dynamic(() => import("./support-workspace").then((module) => module.SupportWorkspace));
const NotificationPreferencesWorkspace = dynamic(() => import("./notification-preferences-workspace").then((module) => module.NotificationPreferencesWorkspace));

export default function ClientPortal({ segments }: { segments: string[] }) {
  const { t } = useAppLocale();
  // 会话由根 layout 的 ClientFrame 解析一次，loading / error / 未登录跳转都在那里
  // 统一处理。页面只做权限判定与工作区分发。
  const session = useAppSessionContext();
  const searchParams = useSearchParams();
  const route = segments[0];
  // 公开条款页必须排在登录判定**之前**。放在后面的话未登录访客仍然看不到条款，
  // 而落地页页脚正是要链接到这里——那就等于把条款藏起来了。
  if (route === "legal" && !segments[1]) return <PublicLegalPage />;
  if (session.status !== "authenticated") return null;
  if (route === "legal" && segments[1] === "consent") return <LegalConsentExperience />;
  if (route === "support") {
    return <><SupportWorkspace /></>;
  }
  if (route === "dashboard" || route === "notifications") return <ClientHomeWorkspace access={session.access} />;
  // 行情页此前只存在于遗留 /workspace 的内部字符串路由（?page=market），
  // 落地页的「行情」链接因此把匿名访客送进一个要求登录的页面。
  if (route === "market") return <LiveMarket />;
  // 策略代码保留，但受保护的研究与回测 API 当前按策略禁用。入口必须失败关闭，
  // 避免把无法完成的流程显示成可用能力；后续通过 Gate 后再恢复工作区。
  if (["strategies", "studio", "backtests"].includes(route)) {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return <StrategyCenterUnavailable />;
  }
  if (["trading", "trading-hall", "paper", "work-records"].includes(route)) {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    const tab = resolveTradingTab(searchParams.get("tab"), route);
    const recordId = route === "work-records" ? segments[1] : searchParams.get("record") ?? undefined;
    const portfolioId = route === "paper" ? segments[1] : searchParams.get("portfolio") ?? undefined;
    const meeting = (route === "trading-hall" && segments[1] === "meeting") || searchParams.get("view") === "meeting";
    return <>
      <ClientHubTabs label="交易中心" active={tab} tabs={[
        { value: "hall", label: "交易决策", href: "/trading?tab=hall" },
        { value: "portfolios", label: "模拟组合", href: "/trading?tab=portfolios" },
        { value: "records", label: "工作记录", href: "/trading?tab=records" },
      ]} />
      {tab === "hall" ? (meeting ? <DecisionMeeting /> : <DecisionHall />)
        : tab === "portfolios" ? <TradingExperience portfolioId={portfolioId} canManage={hasAnyPermission(session.access.permissions, ["client.paper.manage"])} />
          : <WorkRecordsWorkspace recordId={recordId} />}
    </>;
  }
  if (route === "assistant") {
    return <AiAssistantChat title="AI 助手" onOpenStrategies={() => window.location.assign("/strategies?tab=research")} />;
  }
  if (["account-center", "membership", "credits", "wallet", "performance-statements"].includes(route)) {
    const canViewMembership = hasAnyPermission(session.access.permissions, ["client.membership.view"]);
    const canViewCredits = hasAnyPermission(session.access.permissions, ["client.credits.view"]);
    const canViewWallet = hasAnyPermission(session.access.permissions, ["client.wallet.view"]);
    const availableTabs = [
      ...(canViewMembership ? ["membership", "statements"] as const : []),
      ...(canViewCredits ? ["credits"] as const : []),
      ...(canViewWallet ? ["wallet", "deposit"] as const : []),
    ];
    const tab = resolveAccountCenterTab(searchParams.get("tab"), route, segments.slice(1), availableTabs);
    const allowed = (tab === "membership" || tab === "statements") ? canViewMembership : tab === "credits" ? canViewCredits : canViewWallet;
    if (!allowed) return <AccessDenied />;
    const statementId = route === "performance-statements" ? segments[1] : searchParams.get("statement") ?? undefined;
    return <>
      <ClientHubTabs label="账户中心" active={tab} tabs={[
        { value: "membership", label: "会员", href: "/account-center?tab=membership", visible: canViewMembership },
        { value: "credits", label: "AI 积分", href: "/account-center?tab=credits", visible: canViewCredits },
        { value: "wallet", label: "钱包", href: "/account-center?tab=wallet", visible: canViewWallet },
        { value: "deposit", label: "充值", href: "/account-center?tab=deposit", visible: canViewWallet },
        { value: "statements", label: "绩效账单", href: "/account-center?tab=statements", visible: canViewMembership },
      ]} />
      {tab === "membership" ? <MembershipExperience canCreateOrder={hasAnyPermission(session.access.permissions, ["client.membership.order"])} />
        : tab === "credits" ? <CreditWorkspace />
          : tab === "wallet" ? <WalletWorkspace />
            : tab === "deposit" ? <DepositWorkspace access={session.access} />
              : <PerformanceStatementsWorkspace statementId={statementId} />}
    </>;
  }
  if (["settings", "account"].includes(route)) {
    const tab = resolveSettingsTab(searchParams.get("tab"), route, segments.slice(1));
    return <>
      <ClientHubTabs label="设置" active={tab} tabs={[
        { value: "profile", label: "个人资料", href: "/settings?tab=profile" },
        { value: "appearance", label: "外观", href: "/settings?tab=appearance" },
        { value: "security", label: "安全", href: "/settings?tab=security" },
        { value: "notifications", label: "通知", href: "/settings?tab=notifications" },
      ]} />
      {tab === "profile" ? <AccountSecurityWorkspace viewer={session.viewer} section="profile" />
        : tab === "appearance" ? <AppPreferenceSettings audience="client" />
          : tab === "security" ? <AccountSecurityWorkspace viewer={session.viewer} section="security" />
            : <NotificationPreferencesWorkspace />}
    </>;
  }
  return <AccessDenied message={t("当前客户页面不存在或没有访问权限。")} />;
}
