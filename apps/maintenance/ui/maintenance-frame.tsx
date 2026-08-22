"use client";

import { ConsoleFrame } from "@/packages/ui/src/console-frame";

import { navigation } from "./navigation";

export default function MaintenanceFrame({ children }: { children: React.ReactNode }) {
  return <ConsoleFrame
    audience="maintenance"
    appName="运维端"
    statusText="控制面操作全程审计"
    accountLabel="运维账户"
    navigation={navigation}
  >{children}</ConsoleFrame>;
}
