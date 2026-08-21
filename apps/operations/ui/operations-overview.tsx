"use client";

import Link from "next/link";

import { formatDecimal, type OperationsActionRequest, type OperationsCustomer } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, PageHeading } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type Statistics = { summary: { totalOrders: string; creditedOrders: string; totalCredited: string; totalFees: string; reviewOrders: string; failedOrders: string } };

export function OperationsOverview({ canViewDeposits, canViewCustomers, canApproveDeposits }: { canViewDeposits: boolean; canViewCustomers: boolean; canApproveDeposits: boolean }) {
  const stats = useApiData<Statistics>(canViewDeposits ? "/api/operations/deposits/statistics" : null, "充值统计读取失败");
  const customers = useApiData<{ customers: OperationsCustomer[]; total: string }>(canViewCustomers ? "/api/operations/customers?limit=1" : null, "客户统计读取失败");
  const approvals = useApiData<{ actionRequests: OperationsActionRequest[] }>(canApproveDeposits ? "/api/operations/deposit-action-requests?status=pending&limit=200" : null, "待审批队列读取失败");
  const loading = stats.loading || customers.loading || approvals.loading;
  if (loading && !stats.data && !customers.data && !approvals.data) return <LoadingState label="正在汇总运营状态…" />;
  const failure = stats.error || customers.error || approvals.error;
  return <>
    <PageHeading eyebrow="RIVERTON OPERATIONS" title="运营概览" description="客户、充值、审批与账务的实时业务状态。" actions={<button className="rc-button" type="button" onClick={() => { void stats.refresh(); void customers.refresh(); void approvals.refresh(); }}>刷新</button>} />
    {failure && <div className="rc-inline-error" role="alert">部分数据未能读取：{failure}</div>}
    <section className="rc-kpi-grid" aria-label="运营关键指标">
      <article><small>权限范围内客户</small><strong>{customers.data?.total ?? "—"}</strong><span>仅统计当前数据范围</span></article>
      <article><small>充值订单</small><strong>{stats.data?.summary.totalOrders ?? "—"}</strong><span>{stats.data ? `${stats.data.summary.creditedOrders} 笔已入账` : "等待数据"}</span></article>
      <article><small>待人工复核</small><strong>{approvals.data?.actionRequests.length ?? "—"}</strong><span>资金操作需第二人审批</span></article>
      <article><small>累计入账</small><strong>{stats.data ? formatDecimal(stats.data.summary.totalCredited) : "—"}</strong><span>真实账本口径</span></article>
    </section>
    <section className="rc-panel">
      <header><div><small>工作队列</small><h2>需要关注</h2></div></header>
      <div className="rc-link-grid">
        <Link href="/deposits">{stats.data?.summary.reviewOrders ?? "—"}<small>人工复核充值</small></Link>
        <Link href="/approvals">{approvals.data?.actionRequests.length ?? "—"}<small>资金审批申请</small></Link>
        <Link href="/ledger">只读<small>不可变账本查询</small></Link>
        <Link href="/finance">人工<small>付款与结算流程</small></Link>
      </div>
    </section>
    {!stats.data && !customers.data && !approvals.data && failure && <ErrorState message={failure} retry={() => { void stats.refresh(); void customers.refresh(); void approvals.refresh(); }} />}
  </>;
}
