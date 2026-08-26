"use client";

import { useEffect } from "react";

import type { ConsoleNavigationGroup } from "@/packages/contracts/src/riverton-ui";

import { AppSessionProvider, useAppSessionContext } from "./app-session-context";
import { ConsoleShell } from "./console-shell";
import { ErrorState, LoadingState } from "./page-state";

function Chrome({ appName, appKind, statusText, accountLabel, navigation, children }: {
  appName: string;
  appKind: "operations" | "maintenance";
  statusText: string;
  accountLabel: string;
  navigation: ConsoleNavigationGroup[];
  children: React.ReactNode;
}) {
  const session = useAppSessionContext();

  useEffect(() => {
    if (session.status !== "anonymous") return;
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [session.status]);

  if (session.status === "loading" || session.status === "anonymous") {
    return <LoadingState label={`正在验证${appName}会话…`} />;
  }
  if (session.status === "error") {
    return <ErrorState message={session.error} retry={session.refresh} />;
  }

  return <ConsoleShell
    appName={appName}
    appKind={appKind}
    statusText={statusText}
    accountLabel={accountLabel}
    navigation={navigation}
    viewer={session.viewer}
    access={session.access}
  >{children}</ConsoleShell>;
}

export default function ConsoleChrome(props: {
  appName: string;
  appKind: "operations" | "maintenance";
  statusText: string;
  accountLabel: string;
  navigation: ConsoleNavigationGroup[];
  children: React.ReactNode;
}) {
  return <AppSessionProvider audience={props.appKind}><Chrome {...props} /></AppSessionProvider>;
}
