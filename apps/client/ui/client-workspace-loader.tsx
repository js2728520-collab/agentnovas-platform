"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";

import { hasAnyPermission } from "@/packages/contracts/src/riverton-ui";
import { AccessDenied, ErrorState, LoadingState } from "@/packages/ui/src/page-state";
import { useAppSession } from "@/packages/ui/src/use-app-session";

import { ClientPortalShell } from "./client-portal-shell";

const ClientApp = dynamic(() => import("./client-app"), {
  loading: () => <LoadingState label="正在加载策略与 Agent 工作区…" />,
});

export default function ClientWorkspaceLoader() {
  const session = useAppSession("client");
  useEffect(() => {
    if (session.status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [session.status]);
  if (session.status === "loading" || session.status === "anonymous") return <LoadingState label="正在验证客户端会话…" />;
  if (session.status === "error") return <ErrorState message={session.error} retry={session.refresh} />;
  if (!hasAnyPermission(session.access.permissions, ["client.paper.view"])) return <AccessDenied message="当前账户没有访问策略与 Agent 工作区的权限。" />;
  return <ClientPortalShell viewer={session.viewer} access={session.access}>
    <ClientApp embedded canViewMembership={hasAnyPermission(session.access.permissions, ["client.membership.view"])} />
  </ClientPortalShell>;
}
