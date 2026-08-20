"use client";

import { useEffect } from "react";

import { AppLogin } from "@/packages/ui/src/app-login";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

import { CreditWorkspace } from "./credit-workspace";
import { DepositWorkspace } from "./deposit-workspace";
import MembershipExperience from "./membership-experience";
import { NotificationWorkspace } from "./notification-workspace";
import TradingExperience from "./trading-experience";
import { WalletWorkspace } from "./wallet-workspace";
import { ClientPortalShell } from "./client-portal-shell";

export default function ClientPortal({ segments, loginMode }: { segments: string[]; loginMode?: "login" | "register" | "forgot" }) {
  const session = useAppSession("client");
  const route = segments[0];
  useEffect(() => {
    if (route !== "login" && session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [route, session.status]);
  if (route === "login") return <AppLogin audience="client" title="Riverton Capital" description="AI 策略研发、回测、模拟盘和会员资产中心。" allowRegistration initialMode={loginMode} />;
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证客户端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
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
  if (route === "paper" || route === "trading-hall") {
    if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied />;
    return <ClientPortalShell viewer={session.viewer} access={session.access}>
      <TradingExperience portfolioId={route === "paper" ? segments[1] : undefined} />
    </ClientPortalShell>;
  }
  if (!hasAnyPermission(session.access.permissions, ["client.wallet.view"])) return <AccessDenied />;
  if (segments[1] === "deposits") return <DepositWorkspace viewer={session.viewer} access={session.access} />;
  return <WalletWorkspace viewer={session.viewer} access={session.access} />;
}
