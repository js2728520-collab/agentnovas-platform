"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";

import type { CommercialLegalConsentStatus } from "@/packages/contracts/src/commercial-beta";
import { AppLogin } from "@/packages/ui/src/app-login";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

import { ClientPortalShell } from "./client-portal-shell";
import { ClientHomeWorkspace } from "./client-home-workspace";

const workspaceLoading = () => <LoadingState label="正在加载客户端模块…" />;
const CreditWorkspace = dynamic(() => import("./credit-workspace").then((module) => module.CreditWorkspace), { loading: workspaceLoading });
const DepositWorkspace = dynamic(() => import("./deposit-workspace").then((module) => module.DepositWorkspace), { loading: workspaceLoading });
const LegalConsentExperience = dynamic(() => import("./legal-consent-experience").then((module) => module.LegalConsentExperience), { loading: workspaceLoading });
const MembershipExperience = dynamic(() => import("./membership-experience"), { loading: workspaceLoading });
const NotificationWorkspace = dynamic(() => import("./notification-workspace").then((module) => module.NotificationWorkspace), { loading: workspaceLoading });
const PerformanceStatementsWorkspace = dynamic(() => import("./performance-statements-workspace").then((module) => module.PerformanceStatementsWorkspace), { loading: workspaceLoading });
const TradingExperience = dynamic(() => import("./trading-experience"), { loading: workspaceLoading });
const WalletWorkspace = dynamic(() => import("./wallet-workspace").then((module) => module.WalletWorkspace), { loading: workspaceLoading });
const AccountSecurityWorkspace = dynamic(() => import("./account-security-workspace").then((module) => module.AccountSecurityWorkspace), { loading: workspaceLoading });
const SupportWorkspace = dynamic(() => import("./support-workspace").then((module) => module.SupportWorkspace), { loading: workspaceLoading });

export default function ClientPortal({ segments, loginMode }: { segments: string[]; loginMode?: "login" | "register" | "forgot" }) {
  const session = useAppSession("client");
  const route = segments[0];
  const isLegalRoute = route === "legal" && segments[1] === "consent";
  const shouldCheckLegalConsent = session.status === "authenticated" && route !== "login" && route !== "account" && route !== "support" && !isLegalRoute;
  const legalConsentGate = useApiData<CommercialLegalConsentStatus>(
    shouldCheckLegalConsent ? "/api/membership/legal-consent" : null,
    "商业披露确认状态读取失败，业务入口保持关闭。",
  );
  useEffect(() => {
    if (route !== "login" && session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [route, session.status]);
  useEffect(() => {
    if (!shouldCheckLegalConsent || !legalConsentGate.data || legalConsentGate.data.consentComplete) return;
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/legal/consent?next=${encodeURIComponent(next)}`);
  }, [legalConsentGate.data, shouldCheckLegalConsent]);
  if (route === "login") return <AppLogin audience="client" title="Riverton Capital" description="AI 策略研发、回测、模拟盘和会员资产中心。" allowRegistration initialMode={loginMode} />;
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证客户端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  if (isLegalRoute) {
    return <ClientPortalShell viewer={session.viewer} access={session.access}>
      <LegalConsentExperience />
    </ClientPortalShell>;
  }
  if (route === "account" && segments[1] === "security") {
    return <ClientPortalShell viewer={session.viewer} access={session.access}><AccountSecurityWorkspace viewer={session.viewer} /></ClientPortalShell>;
  }
  if (route === "support") {
    return <ClientPortalShell viewer={session.viewer} access={session.access}><SupportWorkspace /></ClientPortalShell>;
  }
  if (shouldCheckLegalConsent && legalConsentGate.loading && !legalConsentGate.data) return <LoadingState label="正在核对当前商业披露版本…" />;
  if (shouldCheckLegalConsent && legalConsentGate.error && !legalConsentGate.data) return <ErrorState message={legalConsentGate.error} retry={legalConsentGate.refresh} />;
  if (shouldCheckLegalConsent && !legalConsentGate.data?.consentComplete) return <LoadingState label="正在进入商业披露确认…" />;
  if (!route) return <ClientHomeWorkspace viewer={session.viewer} access={session.access} />;
  if (route === "notifications") return <NotificationWorkspace viewer={session.viewer} access={session.access} />;
  if (route === "membership") {
    if (!hasAnyPermission(session.access.permissions, ["client.membership.view"])) return <AccessDenied />;
    return <ClientPortalShell viewer={session.viewer} access={session.access}>
      <MembershipExperience canCreateOrder={hasAnyPermission(session.access.permissions, ["client.membership.order"])} />
    </ClientPortalShell>;
  }
  if (route === "credits") {
    if (!hasAnyPermission(session.access.permissions, ["client.credits.view"])) return <AccessDenied />;
    return <CreditWorkspace viewer={session.viewer} access={session.access} />;
  }
  if (route === "performance-statements") {
    if (!hasAnyPermission(session.access.permissions, ["client.membership.view"])) return <AccessDenied />;
    return <PerformanceStatementsWorkspace viewer={session.viewer} access={session.access} statementId={segments[1]} />;
  }
  if (route === "paper" || route === "trading-hall") {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return <ClientPortalShell viewer={session.viewer} access={session.access}>
      <TradingExperience
        portfolioId={route === "paper" ? segments[1] : undefined}
        canManage={hasAnyPermission(session.access.permissions, ["client.paper.manage"])}
      />
    </ClientPortalShell>;
  }
  if (!hasAnyPermission(session.access.permissions, ["client.wallet.view"])) return <AccessDenied />;
  if (segments[1] === "deposits") return <DepositWorkspace viewer={session.viewer} access={session.access} />;
  return <WalletWorkspace viewer={session.viewer} access={session.access} />;
}
