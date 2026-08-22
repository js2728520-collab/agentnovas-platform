"use client";

import Link from "next/link";

import type { CursorPage, MembershipOrder, PerformanceFeeStatement } from "@/packages/contracts/src/commercial-beta";
import { formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type LedgerTransaction = {
  id: string;
  type: string;
  sourceType: string;
  sourceId: string;
  currency: string;
  status: string;
  createdAt: string;
  postings: Array<{ id: string; side: string; amount: string; currency: string }>;
};

export function FinanceWorkspace({ canViewLedger, canViewMembership, canViewPerformance }: { canViewLedger: boolean; canViewMembership: boolean; canViewPerformance: boolean }) {
  return <>
    <PageHeading eyebrow="COMMERCIAL FINANCE" title="商业财务" description="会员外部付款凭证、Paper 周分成应收和不可变商业账本。系统不生成链上地址，不执行自动收付款。" />
    <div className="rc-callout">会员审批只激活站内权益；周分成付款复核只确认外部凭证。任何页面状态都不代表平台代客户持有或划转资金。</div>
    <section className="rc-card-grid">
      {canViewMembership ? <MembershipFinance /> : null}
      {canViewPerformance ? <PerformanceFinance /> : null}
      {canViewLedger ? <LedgerFinance /> : null}
    </section>
    {!canViewLedger && !canViewMembership && !canViewPerformance ? <section className="rc-panel"><EmptyState title="无商业财务查看权限" description="请由授权管理员分配会员、周分成或账本的只读权限。" /></section> : null}
    <section className="rc-panel"><header><div><small>LEGACY BOUNDARY</small><h2>遗留财务流程</h2></div><StatusBadge value="disabled" /></header><p>旧 settlements、collections、payout profiles 和账务 adjustment 写接口已由中央 API Policy 硬关闭。历史数据仅保留用于迁移核对，不进入商用 Paper 账单或付款流程。</p></section>
  </>;
}

function MembershipFinance() {
  const resource = useApiData<CursorPage<MembershipOrder>>("/api/operations/membership-orders?limit=20", "会员订单读取失败");
  return <article className="rc-card"><header><div><small>MEMBERSHIP</small><h2>会员订单</h2></div><Link className="rc-button" href="/membership-orders">进入队列</Link></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.data.length ? <EmptyState title="没有会员订单" description="当前数据范围内没有订单。" /> : <div className="rc-card-list">{resource.data.data.slice(0, 5).map((order) => <article key={order.id}><header><div><b>{order.orderNo}</b><small>{order.plan.name} · {formatDecimal(order.plan.priceUsd, 2)} USD</small></div><StatusBadge value={order.status} /></header><small>客户 {order.customerId} · {formatDateTime(order.createdAt)}</small></article>)}</div>}<p>当前页 {resource.data?.data.length ?? 0} 笔；外部付款由脱敏凭证和 maker-checker 复核。</p></article>;
}

function PerformanceFinance() {
  const resource = useApiData<CursorPage<PerformanceFeeStatement>>("/api/operations/performance-statements?limit=20", "周分成账单读取失败");
  return <article className="rc-card"><header><div><small>PAPER PERFORMANCE FEE</small><h2>周分成应收</h2></div><Link className="rc-button" href="/performance-statements">进入队列</Link></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.data.length ? <EmptyState title="没有周分成账单" description="当前数据范围内没有账单。" /> : <div className="rc-card-list">{resource.data.data.slice(0, 5).map((statement) => <article key={statement.id}><header><div><b>{formatDecimal(statement.feeAmount)} USDT</b><small>{formatDateTime(statement.cycleStartedAt)} — {formatDateTime(statement.cycleEndedAt)}</small></div><StatusBadge value={statement.status} /></header><small>客户 {statement.customerId} · 仅基于官方三卡已平仓 Paper 净收益</small></article>)}</div>}<p>当前页 {resource.data?.data.length ?? 0} 笔；高水位只在外部付款凭证复核完成后提交。</p></article>;
}

function LedgerFinance() {
  const resource = useApiData<{ transactions: LedgerTransaction[]; nextCursor: string | null }>("/api/operations/ledger?limit=20", "商业账本读取失败");
  return <article className="rc-card"><header><div><small>IMMUTABLE LEDGER</small><h2>不可变账本</h2></div><Link className="rc-button" href="/ledger">进入账本</Link></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.transactions.length ? <EmptyState title="没有账本分录" description="当前数据范围内没有分录。" /> : <div className="rc-card-list">{resource.data.transactions.slice(0, 5).map((transaction) => <article key={transaction.id}><header><div><b>{transaction.type}</b><small>{transaction.sourceType} · {transaction.sourceId}</small></div><StatusBadge value={transaction.status} /></header><small>{transaction.postings.length} 条借贷分录 · {transaction.currency} · {formatDateTime(transaction.createdAt)}</small></article>)}</div>}<p>只读且只能冲正；页面不提供编辑或删除入口。</p></article>;
}
