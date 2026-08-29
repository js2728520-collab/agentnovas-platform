"use client";

import Link from "next/link";

import { formatDateTime, formatDecimal, type OperationsActionRequest, type OperationsCustomer } from "@/packages/contracts/src/riverton-ui";
import { LoadingState, PageHeading } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type Statistics = { summary: { totalOrders: string; creditedOrders: string; totalCredited: string; totalFees: string; reviewOrders: string; failedOrders: string } };
type KillSwitchView = { id: string; active: boolean };
type LiveRoutingView = { id: string; environment: "demo" | "live"; status: "pending" | "granted" | "revoked" };
type LiveRoutingReadiness = { grants: LiveRoutingView[]; activationReady?: boolean; blockerCodes?: string[] };

export function OperationsOverview({
  canViewDeposits,
  canViewCustomers,
  canApproveDeposits,
  canViewTrading,
}: {
  canViewDeposits: boolean;
  canViewCustomers: boolean;
  canApproveDeposits: boolean;
  canViewTrading: boolean;
}) {
  const { locale, t } = useAppLocale();
  const stats = useApiData<Statistics>(canViewDeposits ? "/api/operations/deposits/statistics" : null, t("充值统计读取失败"));
  const customers = useApiData<{ customers: OperationsCustomer[]; total: string }>(canViewCustomers ? "/api/operations/customers?limit=1" : null, t("客户统计读取失败"));
  const approvals = useApiData<{ actionRequests: OperationsActionRequest[] }>(canApproveDeposits ? "/api/operations/deposit-action-requests?status=pending&limit=200" : null, t("待审批队列读取失败"));
  const switches = useApiData<{ switches: KillSwitchView[] }>(canViewTrading ? "/api/operations/kill-switches?active=true" : null, t("交易熔断读取失败"));
  const routing = useApiData<LiveRoutingReadiness>(canViewTrading ? "/api/operations/live-routing" : null, t("实盘路由状态读取失败"));
  const resources = [stats, customers, approvals, switches, routing];
  const loading = resources.some((resource) => resource.loading);
  const hasData = resources.some((resource) => resource.data);
  const failures = resources.map((resource) => resource.error).filter(Boolean);
  const observedAt = new Date().toISOString();
  const activeSwitches = switches.data?.switches.filter((entry) => entry.active).length ?? 0;
  const routingBlockers = routing.data?.blockerCodes?.length ?? 0;
  const canViewAttention = canViewDeposits || canApproveDeposits || canViewTrading;
  const sourceLabels = [
    canViewCustomers ? t("客户") : null,
    canViewDeposits ? t("充值") : null,
    canApproveDeposits ? t("资金审批") : null,
    canViewTrading ? t("交易熔断与实盘路由") : null,
  ].filter(Boolean).join(locale === "zh-CN" ? "、" : ", ");

  function refresh() {
    for (const resource of resources) void resource.refresh();
  }

  return <>
    <PageHeading eyebrow="RIVERTON OPERATIONS" title={t("运营看板")} description={t("仅汇总当前权限范围内、能驱动处理决策的客户、财务、审批与交易风险数据。")} actions={<button className="rc-button" type="button" onClick={refresh}>{t("刷新数据")}</button>} />
    <p className="rc-dashboard-meta"><time dateTime={observedAt}>{t("本次读取")} {formatDateTime(observedAt, locale)}</time><span>{t("数据来源：")}{sourceLabels || t("当前权限无可用指标")}</span></p>
    {failures.length > 0 && <div className="rc-inline-error" role="alert">{t("部分数据不可用：")}{failures.join(locale === "zh-CN" ? "；" : "; ")}</div>}
    {loading && !hasData ? <LoadingState label={t("正在汇总运营看板…")} /> : <section className="rc-kpi-grid" aria-label={t("运营关键指标")}>
      {canViewCustomers && <article><small>{t("权限范围内客户")}</small><strong>{customers.data?.total ?? "—"}</strong><span>{t("口径：当前 RBAC 数据范围")}</span></article>}
      {canViewDeposits && <article><small>{t("累计充值入账")}</small><strong>{stats.data ? `${formatDecimal(stats.data.summary.totalCredited, 6, locale)} USDT` : "—"}</strong><span>{stats.data ? `${stats.data.summary.creditedOrders}/${stats.data.summary.totalOrders} ${t("笔已入账")}` : t("状态待读取")}</span></article>}
      {canApproveDeposits && <article><small>{t("待资金审批")}</small><strong>{approvals.data?.actionRequests.length ?? "—"}</strong><span>{t("状态：等待第二人复核")}</span></article>}
      {canViewTrading && <article><small>{t("生效中的熔断")}</small><strong>{switches.data ? activeSwitches : "—"}</strong><span>{t("口径：交易所、账户与策略范围")}</span></article>}
      {canViewTrading && <article><small>{t("实盘安全闸门")}</small><strong>{routing.data ? routing.data.activationReady ? t("已通过") : t("关闭") : "—"}</strong><span>{routing.data?.activationReady ? t("仍需逐条双人审批") : t("真实交易不会执行")}</span></article>}
    </section>}
    {canViewAttention && <section className="rc-panel" aria-labelledby="operations-attention-title">
      <header><div><small>{t("异常与待处理")}</small><h2 id="operations-attention-title">{t("需要关注")}</h2></div></header>
      <div className="rc-link-grid">
        {canViewDeposits && <Link href="/commercial?tab=deposits">{stats.data?.summary.reviewOrders ?? "—"}<small>{t("人工复核充值")}</small></Link>}
        {canViewDeposits && <Link href="/commercial?tab=deposits">{stats.data?.summary.failedOrders ?? "—"}<small>{t("失败充值订单")}</small></Link>}
        {canApproveDeposits && <Link href="/governance?tab=approvals">{approvals.data?.actionRequests.length ?? "—"}<small>{t("资金审批申请")}</small></Link>}
        {canViewTrading && <Link href="/trading-operations?tab=controls">{switches.data ? activeSwitches : "—"}<small>{t("生效中的熔断")}</small></Link>}
        {canViewTrading && <Link href="/trading-operations?tab=routing">{routing.data ? routingBlockers : "—"}<small>{t("实盘安全阻断项")}</small></Link>}
      </div>
    </section>}
  </>;
}
