"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";

import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

import { ClientPortalShell } from "./client-portal-shell";
import { ClientHomeWorkspace } from "./client-home-workspace";

const CreditWorkspace = dynamic(() => import("./credit-workspace").then((module) => module.CreditWorkspace));
const DepositWorkspace = dynamic(() => import("./deposit-workspace").then((module) => module.DepositWorkspace));
const LegalConsentExperience = dynamic(() => import("./legal-consent-experience").then((module) => module.LegalConsentExperience));
const MembershipExperience = dynamic(() => import("./membership-experience"));
const NotificationWorkspace = dynamic(() => import("./notification-workspace").then((module) => module.NotificationWorkspace));
const PerformanceStatementsWorkspace = dynamic(() => import("./performance-statements-workspace").then((module) => module.PerformanceStatementsWorkspace));
const TradingExperience = dynamic(() => import("./trading-experience"));
const WalletWorkspace = dynamic(() => import("./wallet-workspace").then((module) => module.WalletWorkspace));
const AccountSecurityWorkspace = dynamic(() => import("./account-security-workspace").then((module) => module.AccountSecurityWorkspace));
const SupportWorkspace = dynamic(() => import("./support-workspace").then((module) => module.SupportWorkspace));

export default function ClientPortal({ segments }: { segments: string[] }) {
  const session = useAppSession("client");
  const route = segments[0];
  useEffect(() => {
    if (session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [route, session.status]);
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证客户端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  if (route === "legal" && segments[1] === "consent") {
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
  if (route === "dashboard") return <ClientHomeWorkspace viewer={session.viewer} access={session.access} />;
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
