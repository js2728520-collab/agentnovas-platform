"use client";

import { formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type DataCenterPayload = {
  summary: Record<string, string>;
  trend: { month: string; registeredCustomers: string; activatedOrders: string; paperFills: string; realizedNetPnl: string }[];
  strategies: { strategyCode: string; portfolios: string; activePortfolios: string; realizedNetPnl: string; paperFees: string }[];
  pendingQueue: { creditAdjustments: string; attributionChanges: string; performanceReviews: string };
  scope: { grant: string; organizationIds: string[] };
};

export function DataCenterWorkspace() {
  const resource = useApiData<DataCenterPayload>("/api/data-center", "数据中心读取失败");
  if (resource.loading && !resource.data) return <LoadingState label="正在计算权限范围内的商业指标…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <EmptyState title="暂无商业指标" description="当前授权范围内没有可汇总的数据。" />;
  const { summary } = resource.data;
  return <>
    <PageHeading eyebrow="SCOPED BUSINESS METRICS" title="运营数据中心" description="仅汇总官方 Paper、已激活会员、Credits 和待审批业务；不读取客户交易所账户、真实交易或完整 PII。" actions={<StatusBadge value={resource.data.scope.grant} />} />
    <section className="rc-kpi-grid"><article><small>可见客户</small><strong>{summary.customers}</strong><span>{summary.activeMemberships} 个有效会员</span></article><article><small>已激活订单</small><strong>{summary.activatedOrders}</strong><span>{summary.pendingMembershipOrders} 笔待复核</span></article><article><small>Paper 组合</small><strong>{summary.paperPortfolios}</strong><span>{summary.openPositions} 个未平仓位</span></article><article><small>Paper 已实现净损益</small><strong>{formatDecimal(summary.realizedNetPnl)}</strong><span>不含平台 Demo 账户</span></article><article><small>客户可用 Credits</small><strong>{formatDecimal(summary.availableCredits, 0)}</strong><span>与 USDT 钱包分离</span></article><article><small>待收绩效服务费</small><strong>{formatDecimal(summary.outstandingPerformanceFees)}</strong><span>仅已生成站内应收</span></article></section>
    <section className="rc-panel"><header><div><small>SIX MONTH TREND</small><h2>六个月真实业务趋势</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button></header><div className="rc-table-wrap"><table><thead><tr><th>月份</th><th>新客户</th><th>激活订单</th><th>Paper 成交回执</th><th>已实现净损益</th></tr></thead><tbody>{resource.data.trend.map((item) => <tr key={item.month}><td>{item.month}</td><td>{item.registeredCustomers}</td><td>{item.activatedOrders}</td><td>{item.paperFills}</td><td>{formatDecimal(item.realizedNetPnl)} USDT</td></tr>)}</tbody></table></div></section>
    <section className="rc-panel"><header><div><small>OFFICIAL STRATEGIES</small><h2>官方策略业务影响</h2></div></header><div className="rc-card-grid">{resource.data.strategies.map((strategy) => <article className="rc-card" key={strategy.strategyCode}><header><StatusBadge value={`${strategy.activePortfolios}/${strategy.portfolios} active`} /></header><h3>{strategy.strategyCode}</h3><p>已实现净损益 {formatDecimal(strategy.realizedNetPnl)} USDT</p><p>模拟手续费 {formatDecimal(strategy.paperFees)} USDT</p></article>)}</div></section>
    <section className="rc-panel"><header><div><small>PENDING QUEUE</small><h2>待处理队列</h2></div></header><div className="rc-link-grid"><a href="/credits">{resource.data.pendingQueue.creditAdjustments}<small>Credits 调整</small></a><a href="/approvals">{resource.data.pendingQueue.attributionChanges}<small>归属调整</small></a><a href="/performance-statements">{resource.data.pendingQueue.performanceReviews}<small>绩效账单复核</small></a></div></section>
  </>;
}
