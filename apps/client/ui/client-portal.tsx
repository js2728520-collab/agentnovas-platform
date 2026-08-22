"use client";

import dynamic from "next/dynamic";

import { AccessDenied } from "@/packages/ui/src/page-state";
import { useAppSessionContext } from "@/packages/ui/src/app-session-context";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

import { ClientHomeWorkspace } from "./client-home-workspace";

const CreditWorkspace = dynamic(() => import("./credit-workspace").then((module) => module.CreditWorkspace));
const DepositWorkspace = dynamic(() => import("./deposit-workspace").then((module) => module.DepositWorkspace));
const LegalConsentExperience = dynamic(() => import("./legal-consent-experience").then((module) => module.LegalConsentExperience));
const MembershipExperience = dynamic(() => import("./membership-experience"));
const AiAssistantChat = dynamic(() => import("./ai-assistant-chat"));
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
  if (route === "market") return <LiveMarket onLogin={() => window.location.assign("/login")} />;
  // AI 助手：行情分析、决策解读、平台与会员规则问答。
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
  if (route === "paper" || route === "trading-hall") {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return <>
      <TradingExperience
        portfolioId={route === "paper" ? segments[1] : undefined}
        canManage={hasAnyPermission(session.access.permissions, ["client.paper.manage"])}
      />
    </>;
  }
  if (!hasAnyPermission(session.access.permissions, ["client.wallet.view"])) return <AccessDenied />;
  if (segments[1] === "deposits") return <DepositWorkspace access={session.access} />;
  return <WalletWorkspace />;
}
