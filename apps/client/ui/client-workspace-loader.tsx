"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";

import type { CommercialLegalConsentStatus } from "@/packages/contracts/src/commercial-beta";
import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppSession } from "@/packages/ui/src/use-app-session";

const ClientApp = dynamic(() => import("./client-app"), {
  loading: () => <LoadingState label="正在加载策略与 Agent 工作区…" />,
});

export default function ClientWorkspaceLoader() {
  const session = useAppSession("client");
  const shouldCheckLegalConsent = session.status === "authenticated";
  const legalConsentGate = useApiData<CommercialLegalConsentStatus>(
    shouldCheckLegalConsent ? "/api/membership/legal-consent" : null,
    "法务确认状态读取失败，策略工作区保持关闭。",
  );
  useEffect(() => {
    if (session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [session.status]);
  useEffect(() => {
    if (!shouldCheckLegalConsent || !legalConsentGate.data || legalConsentGate.data.consentComplete) return;
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/legal/consent?next=${encodeURIComponent(next)}`);
  }, [legalConsentGate.data, shouldCheckLegalConsent]);
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证客户端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  if (legalConsentGate.loading && !legalConsentGate.data) return <LoadingState label="正在核对当前法务版本…" />;
  if (legalConsentGate.error && !legalConsentGate.data) return <ErrorState message={legalConsentGate.error} retry={legalConsentGate.refresh} />;
  if (!legalConsentGate.data?.consentComplete) return <LoadingState label="正在进入法务确认…" />;
  if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied message="当前账户没有访问策略与 Agent 工作区的权限。" />;
  return <ClientApp canViewMembership={hasAnyPermission(session.access.permissions, ["client.membership.view"])} />;
}
