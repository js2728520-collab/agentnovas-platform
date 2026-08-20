"use client";

import type { EffectiveAccessPayload, ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { ClientPortalShell } from "./client-portal-shell";

export function DepositWorkspace({ viewer, access }: { viewer: ViewerPayload; access: EffectiveAccessPayload }) {
  return <ClientPortalShell viewer={viewer} access={access}>
    <PageHeading eyebrow="CLIENT DEPOSITS · BETA" title="充值暂不开放" description="Beta 阶段只提供钱包与不可变账本的只读核对，不创建充值订单，也不会展示收款信息。" />
    <section className="rc-panel" aria-labelledby="deposit-beta-title">
      <header><div><small>CONTROLLED RELEASE</small><h2 id="deposit-beta-title">充值能力尚未发布</h2></div><StatusBadge value="BETA CLOSED" /></header>
      <div className="rc-callout" role="status">
        当前没有面向 Client 的自动充值流程。请勿向任何非团队正式渠道提供的地址转账；页面不会生成地址、付款码或成功回执。
      </div>
      <dl className="rc-detail-grid">
        <div><dt>钱包</dt><dd>仅查看服务端余额</dd></div>
        <div><dt>账本</dt><dd>仅查看不可变流水</dd></div>
        <div><dt>充值订单</dt><dd>暂不开放</dd></div>
        <div><dt>提现与划转</dt><dd>产品边界外</dd></div>
      </dl>
    </section>
  </ClientPortalShell>;
}
