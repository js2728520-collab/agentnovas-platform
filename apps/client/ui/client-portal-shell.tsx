"use client";

import type { EffectiveAccessPayload, ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { ConsoleShell } from "@/packages/ui/src/console-shell";

const navigation = [
  { href: "/", label: "返回交易工作区", icon: "↩" },
  { href: "/wallet", label: "钱包与账本", icon: "◫", requiredPermissions: ["client.wallet.view"] },
  { href: "/wallet/deposits", label: "充值订单", icon: "＋", requiredPermissions: ["client.deposit.create"] },
  { href: "/notifications", label: "通知中心", icon: "◌" },
];

export function ClientPortalShell({ viewer, access, children }: { viewer: ViewerPayload; access: EffectiveAccessPayload; children: React.ReactNode }) {
  return <ConsoleShell appName="客户端资产中心" appKind="client" navigation={navigation} viewer={viewer} access={access}>{children}</ConsoleShell>;
}
