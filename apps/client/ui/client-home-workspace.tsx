"use client";

import Link from "next/link";

import { hasAnyPermission, type EffectiveAccessPayload, type ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";

import { ClientPortalShell } from "./client-portal-shell";

const modules = [
  { href: "/membership", permission: "client.membership.view", title: "会员与法务", description: "查看四档计划、七份法务正文、人工付款申请和会员状态。" },
  { href: "/credits", permission: "client.credits.view", title: "AI 积分", description: "查看与 USDT 钱包分离的可用、预留、累计发放和累计消耗。" },
  { href: "/paper", permission: "client.paper.view", title: "三卡 Paper", description: "每张官方策略独立 10,000 USDT；只展示服务端模拟持仓与成交。" },
  { href: "/trading-hall", permission: "client.paper.view", title: "七智能体交易大厅", description: "核对七阶段决策证据、现货边界和真实订单关闭状态。" },
  { href: "/wallet", permission: "client.wallet.view", title: "只读钱包", description: "查看平台服务余额和不可变账本；Beta 不开放客户充值。" },
] as const;

export function ClientHomeWorkspace({ viewer, access }: { viewer: ViewerPayload; access: EffectiveAccessPayload }) {
  const visible = modules.filter((module) => hasAnyPermission(access.permissions, [module.permission]));
  return <ClientPortalShell viewer={viewer} access={access}>
    <PageHeading eyebrow="RIVERTON CAPITAL · CONTROLLED BETA" title="客户工作台" description="官方现货策略只运行于服务端 paper 组合；平台 Demo 回执与客户收益完全分离，真实订单、客户密钥和自动支付保持关闭。" actions={<StatusBadge value="INVITE ONLY" />} />
    <section className="rc-kpi-grid" aria-label="Beta 产品边界">
      <article><small>官方策略</small><strong>3</strong><span>稳健 / 平衡 / 激进</span></article>
      <article><small>单卡模拟本金</small><strong>10,000</strong><span>USDT paper，不是真实资产</span></article>
      <article><small>客户交易所密钥</small><strong>0</strong><span>不上传、不读取、不路由</span></article>
      <article><small>真实订单</small><strong>关闭</strong><span>现货与永续均不可达</span></article>
    </section>
    <section className="rc-panel"><header><div><small>PERMISSION-AWARE MODULES</small><h2>可用模块</h2></div><StatusBadge value={`${visible.length} 项`} /></header>
      <div className="rc-card-grid">{visible.map((module) => <Link className="rc-card-link" href={module.href} key={module.href}><strong>{module.title}</strong><p>{module.description}</p><span>进入模块 →</span></Link>)}</div>
    </section>
  </ClientPortalShell>;
}
