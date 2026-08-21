"use client";

import type { EffectiveAccessPayload, ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { ConsoleShell } from "@/packages/ui/src/console-shell";

const navigation = [
  { href: "/", label: "客户工作台", icon: "⌂" },
  { href: "/workspace", label: "策略与 Agent", icon: "↗", requiredPermissions: ["client.paper.view"] },
  { href: "/legal/consent", label: "商业披露", icon: "✓" },
  { href: "/membership", label: "会员中心", icon: "◇", requiredPermissions: ["client.membership.view"] },
  { href: "/performance-statements", label: "绩效账单", icon: "≋", requiredPermissions: ["client.membership.view"] },
  { href: "/credits", label: "AI 积分", icon: "◎", requiredPermissions: ["client.credits.view"] },
  { href: "/paper", label: "模拟组合", icon: "▥", requiredPermissions: ["client.paper.view"] },
  { href: "/trading-hall", label: "七智能体交易大厅", icon: "◈", requiredPermissions: ["client.paper.view"] },
  { href: "/wallet", label: "钱包与账本", icon: "◫", requiredPermissions: ["client.wallet.view"] },
  { href: "/wallet/deposits", label: "USDT 充值", icon: "＋", requiredPermissions: ["client.wallet.view"] },
  { href: "/notifications", label: "通知中心", icon: "◌" },
  { href: "/account/security", label: "账号安全", icon: "盾" },
  { href: "/support", label: "支持与公告", icon: "?" },
];

export function ClientPortalShell({ viewer, access, children }: { viewer: ViewerPayload; access: EffectiveAccessPayload; children: React.ReactNode }) {
  return <ConsoleShell appName="客户端资产中心" appKind="client" statusText="客户资产与通知中心" accountLabel="客户账户" navigation={navigation} viewer={viewer} access={access}>{children}</ConsoleShell>;
}
