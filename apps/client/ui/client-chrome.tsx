"use client";

import { useEffect } from "react";

import { AppSessionProvider, useAppSessionContext } from "@/packages/ui/src/app-session-context";
import { ErrorState, LoadingState } from "@/packages/ui/src/page-state";

import { ClientPortalShell } from "./client-portal-shell";

function Chrome({ children }: { children: React.ReactNode }) {
  const session = useAppSessionContext();

  useEffect(() => {
    if (session.status !== "anonymous") return;
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [session.status]);

  if (session.status === "loading" || session.status === "anonymous") {
    return <LoadingState label="正在验证客户端会话…" />;
  }
  if (session.status === "error") {
    return <ErrorState message={session.error} retry={session.refresh} />;
  }
  return <ClientPortalShell viewer={session.viewer} access={session.access}>{children}</ClientPortalShell>;
}

export default function ClientChrome({ children }: { children: React.ReactNode }) {
  return <AppSessionProvider audience="client"><Chrome>{children}</Chrome></AppSessionProvider>;
}
