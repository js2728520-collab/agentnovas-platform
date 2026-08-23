"use client";

import dynamic from "next/dynamic";

import { AccessDenied } from "@/packages/ui/src/page-state";
import { useAppSessionContext } from "@/packages/ui/src/app-session-context";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

import { ClientHomeWorkspace } from "./client-home-workspace";

const CreditWorkspace = dynamic(() => import("./credit-workspace").then((module) => module.CreditWorkspace));
const DepositWorkspace = dynamic(() => import("./deposit-workspace").then((module) => module.DepositWorkspace));
const LegalConsentExperience = dynamic(() => import("./legal-consent-experience").then((module) => module.LegalConsentExperience));
const PublicLegalPage = dynamic(() => import("./public-legal-page").then((module) => module.PublicLegalPage));
const MembershipExperience = dynamic(() => import("./membership-experience"));
const AiAssistantChat = dynamic(() => import("./ai-assistant-chat"));
const DecisionHall = dynamic(() => import("./decision-hall"));
const StrategyStudio = dynamic(() => import("./strategy-studio"));
const BacktestWorkspace = dynamic(() => import("./backtest-workspace"));
const DecisionMeeting = dynamic(() => import("./decision-hall").then((module) => module.DecisionMeeting));
const LiveMarket = dynamic(() => import("./live-market"));
const NotificationWorkspace = dynamic(() => import("./notification-workspace").then((module) => module.NotificationWorkspace));
const PerformanceStatementsWorkspace = dynamic(() => import("./performance-statements-workspace").then((module) => module.PerformanceStatementsWorkspace));
const TradingExperience = dynamic(() => import("./trading-experience"));
const WalletWorkspace = dynamic(() => import("./wallet-workspace").then((module) => module.WalletWorkspace));
const AccountSecurityWorkspace = dynamic(() => import("./account-security-workspace").then((module) => module.AccountSecurityWorkspace));
const SupportWorkspace = dynamic(() => import("./support-workspace").then((module) => module.SupportWorkspace));

export default function ClientPortal({ segments }: { segments: string[] }) {
  // 会话由根 layout 的 ClientFrame 解析一次，loading / error / 未登录跳转都在那里
  // 统一处理。页面只做权限判定与工作区分发。
  const session = useAppSessionContext();
  const route = segments[0];
  // 公开条款页必须排在登录判定**之前**。放在后面的话未登录访客仍然看不到条款，
  // 而落地页页脚正是要链接到这里——那就等于把条款藏起来了。
  if (route === "legal" && !segments[1]) return <PublicLegalPage />;
  if (session.status !== "authenticated") return null;
  if (route === "legal" && segments[1] === "consent") {
    return <>
      <LegalConsentExperience />
    </>;
  }
  if (route === "account" && segments[1] === "security") {
    return <><AccountSecurityWorkspace viewer={session.viewer} /></>;
  }
  if (route === "support") {
    return <><SupportWorkspace /></>;
  }
  if (route === "dashboard") return <ClientHomeWorkspace viewer={session.viewer} access={session.access} />;
  if (route === "notifications") return <NotificationWorkspace />;
  // 行情页此前只存在于遗留 /workspace 的内部字符串路由（?page=market），
  // 落地页的「行情」链接因此把匿名访客送进一个要求登录的页面。
  if (route === "market") return <LiveMarket />;
  // AI 助手：行情分析、决策解读、平台与会员规则问答。
  // 策略实验室：多智能体研发流水线（检查点式、样本外验证、确定性准入）。
  // 服务端一直都在，此前唯一的入口是运行时不可达的遗留页面。
  if (route === "studio") {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return <StrategyStudio />;
  }
  // 已保存策略的可配置历史回测。与 /studio 的分工见 backtest-workspace.tsx。
  if (route === "backtests") {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return <BacktestWorkspace strategyId={segments[1]} />;
  }
  if (route === "assistant") {
    return <AiAssistantChat title="AI 助手" onOpenStrategies={() => window.location.assign("/trading-hall")} />;
  }
  if (route === "membership") {
    if (!hasAnyPermission(session.access.permissions, ["client.membership.view"])) return <AccessDenied />;
    return <>
      <MembershipExperience canCreateOrder={hasAnyPermission(session.access.permissions, ["client.membership.order"])} />
    </>;
  }
  if (route === "credits") {
    if (!hasAnyPermission(session.access.permissions, ["client.credits.view"])) return <AccessDenied />;
    return <CreditWorkspace />;
  }
  if (route === "performance-statements") {
    if (!hasAnyPermission(session.access.permissions, ["client.membership.view"])) return <AccessDenied />;
    return <PerformanceStatementsWorkspace statementId={segments[1]} />;
  }
  // 「交易大厅」渲染七智能体大厅可视化，「模拟组合」渲染组合与成交明细。
  // 此前两条路由渲染同一个组件，导航上两个不同标签指向同一个页面。
  if (route === "trading-hall") {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return segments[1] === "meeting" ? <DecisionMeeting /> : <DecisionHall />;
  }
  if (route === "paper") {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return <>
      <TradingExperience
        portfolioId={segments[1]}
        canManage={hasAnyPermission(session.access.permissions, ["client.paper.manage"])}
      />
    </>;
  }
  if (!hasAnyPermission(session.access.permissions, ["client.wallet.view"])) return <AccessDenied />;
  if (segments[1] === "deposits") return <DepositWorkspace access={session.access} />;
  return <WalletWorkspace />;
}
