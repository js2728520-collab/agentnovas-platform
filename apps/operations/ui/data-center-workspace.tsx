"use client";

import Link from "next/link";

import { formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type DataCenterPayload = {
  summary: Record<string, string>;
  trend: { month: string; registeredCustomers: string; activatedOrders: string; paperFills: string; realizedNetPnl: string }[];
  strategies: { strategyCode: string; portfolios: string; activePortfolios: string; realizedNetPnl: string; paperFees: string }[];
  pendingQueue: { creditAdjustments: string; attributionChanges: string; performanceReviews: string };
  scope: { grant: string; organizationIds: string[] };
};

export function DataCenterWorkspace() {
  const { t } = useAppLocale();
  const resource = useApiData<DataCenterPayload>("/api/data-center", t("数据中心读取失败"));
  if (resource.loading && !resource.data) return <LoadingState label={t("正在计算权限范围内的商业指标…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <EmptyState title={t("暂无商业指标")} description={t("当前授权范围内没有可汇总的数据。")} />;
  const { summary } = resource.data;
  return <>
    <PageHeading eyebrow="SCOPED BUSINESS METRICS" title={t("运营数据中心")} description={t("仅汇总官方 Paper、已激活会员、Credits 和待审批业务；不读取客户交易所账户、真实交易或完整 PII。")} actions={<StatusBadge value={resource.data.scope.grant} />} />
    <section className="rc-kpi-grid"><article><small>{t("可见客户")}</small><strong>{summary.customers}</strong><span>{summary.activeMemberships} {t("个有效会员")}</span></article><article><small>{t("已激活订单")}</small><strong>{summary.activatedOrders}</strong><span>{summary.pendingMembershipOrders} {t("笔待复核")}</span></article><article><small>{t("Paper 组合")}</small><strong>{summary.paperPortfolios}</strong><span>{summary.openPositions} {t("个未平仓位")}</span></article><article><small>{t("Paper 已实现净损益")}</small><strong>{formatDecimal(summary.realizedNetPnl)}</strong><span>{t("不含平台 Demo 账户")}</span></article><article><small>{t("客户可用 Credits")}</small><strong>{formatDecimal(summary.availableCredits, 0)}</strong><span>{t("与 USDT 钱包分离")}</span></article><article><small>{t("待收绩效服务费")}</small><strong>{formatDecimal(summary.outstandingPerformanceFees)}</strong><span>{t("仅已生成站内应收")}</span></article></section>
    <section className="rc-panel"><header><div><small>SIX MONTH TREND</small><h2>{t("六个月真实业务趋势")}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></header><div className="rc-table-wrap"><table><thead><tr><th>{t("月份")}</th><th>{t("新客户")}</th><th>{t("激活订单")}</th><th>{t("Paper 成交回执")}</th><th>{t("已实现净损益")}</th></tr></thead><tbody>{resource.data.trend.map((item) => <tr key={item.month}><td>{item.month}</td><td>{item.registeredCustomers}</td><td>{item.activatedOrders}</td><td>{item.paperFills}</td><td>{formatDecimal(item.realizedNetPnl)} USDT</td></tr>)}</tbody></table></div></section>
    <section className="rc-panel"><header><div><small>OFFICIAL STRATEGIES</small><h2>{t("官方策略业务影响")}</h2></div></header><div className="rc-card-grid">{resource.data.strategies.map((strategy) => <article className="rc-card" key={strategy.strategyCode}><header><StatusBadge value={`${strategy.activePortfolios}/${strategy.portfolios} active`} /></header><h3>{strategy.strategyCode}</h3><p>{t("已实现净损益")} {formatDecimal(strategy.realizedNetPnl)} USDT</p><p>{t("模拟手续费")} {formatDecimal(strategy.paperFees)} USDT</p></article>)}</div></section>
    <section className="rc-panel"><header><div><small>PENDING QUEUE</small><h2>{t("待处理队列")}</h2></div></header><div className="rc-link-grid"><Link href="/commercial?tab=credits">{resource.data.pendingQueue.creditAdjustments}<small>{t("Credits 调整")}</small></Link><Link href="/governance?tab=approvals">{resource.data.pendingQueue.attributionChanges}<small>{t("归属调整")}</small></Link><Link href="/commercial?tab=statements">{resource.data.pendingQueue.performanceReviews}<small>{t("绩效账单复核")}</small></Link></div></section>
  </>;
}
