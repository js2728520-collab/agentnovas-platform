"use client";

import type { AiCreditBalance } from "@/packages/contracts/src/commercial-beta";
import { formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";


export function CreditWorkspace() {
  const resource = useApiData<{ credits: AiCreditBalance }>("/api/credits/me", "AI 积分读取失败");
  const credits = resource.data?.credits;
  return <>
    <PageHeading eyebrow="CLIENT AI CREDITS · READ ONLY" title="AI 积分" description="积分与 USDT 钱包完全分离，只能由有效会员计划发放并按可计量模型用量扣减；Beta 不提供积分充值。" />
    {resource.loading && !credits ? <LoadingState label="正在读取 AI 积分…" /> : resource.error && !credits ? <ErrorState message={resource.error} retry={resource.refresh} /> : credits ? <>
      <section className="rc-kpi-grid" aria-label="AI 积分余额">
        <article><small>可用</small><strong>{credits.available}</strong><span>可用于已配置且可计量的 AI 服务</span></article>
        <article><small>预留</small><strong>{credits.reserved}</strong><span>请求完成后按实际 usage 结算差额</span></article>
        <article><small>累计发放</small><strong>{credits.lifetimeGranted}</strong><span>来自会员激活与受控调整</span></article>
        <article><small>累计消耗</small><strong>{credits.lifetimeConsumed}</strong><span>不可为负，不与 paper 收益抵扣</span></article>
      </section>
      <section className="rc-panel"><header><div><small>IMMUTABLE CREDIT ACCOUNT</small><h2>积分账户边界</h2></div><StatusBadge value={`版本 ${credits.version}`} /></header>
        <p>最后更新：{formatDateTime(credits.updatedAt)}</p>
        <div className="rc-callout" role="note">未配置费率、无法返回可靠 token usage 或余额不足时，付费 AI 请求会明确拒绝，不会透支或生成假扣费。</div>
      </section>
    </> : null}
  </>;
}
