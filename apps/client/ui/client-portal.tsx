"use client";

import { useEffect } from "react";

import { AppLogin } from "@/packages/ui/src/app-login";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";

import { DepositWorkspace } from "./deposit-workspace";
import { NotificationWorkspace } from "./notification-workspace";
import { WalletWorkspace } from "./wallet-workspace";

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
  if (!hasAnyPermission(session.access.permissions, ["client.wallet.view"])) return <AccessDenied />;
  if (segments[1] === "deposits") return <DepositWorkspace viewer={session.viewer} access={session.access} />;
  return <WalletWorkspace viewer={session.viewer} access={session.access} />;
}
