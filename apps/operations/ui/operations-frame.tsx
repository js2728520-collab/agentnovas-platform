"use client";

import { ConsoleFrame } from "@/packages/ui/src/console-frame";

import { navigation } from "./navigation";

export default function OperationsFrame({ children }: { children: React.ReactNode }) {
  return <ConsoleFrame
    audience="operations"
    appName="运营端"
    statusText="运营数据按权限范围展示"
    accountLabel="运营账户"
    navigation={navigation}
  >{children}</ConsoleFrame>;
}
