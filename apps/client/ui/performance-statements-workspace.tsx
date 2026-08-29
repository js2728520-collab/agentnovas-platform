"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import type {
  ClientPerformanceStatementDetail,
  CursorPage,
  PerformanceFeeStatement,
  PerformanceStatementTimelineEvent,
} from "@/packages/contracts/src/commercial-beta";
import { formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import { strategyLabel } from "./client-account-presentation";
import styles from "./performance-statements-workspace.module.css";

const statementStatusLabels: Record<PerformanceFeeStatement["status"], string> = {
  SUBMITTED: "待确认",
  APPROVED: "已确认",
  REJECTED: "需要调整",
  INVOICED: "待支付",
  PAID: "已结清",
  CLOSED_NO_FEE: "无需支付",
};

export const performanceStatementTimelineLabels: Record<
  PerformanceStatementTimelineEvent["kind"],
  { title: string; detail: string }
> = {
  STATEMENT_CREATED: { title: "账单已生成", detail: "已根据本周期模拟交易结果生成账单。" },
  ASSESSMENT_APPROVED: { title: "金额已确认", detail: "账单金额已经确认。" },
  ASSESSMENT_REJECTED: { title: "账单需要调整", detail: "更新完成后会再次通知。" },
  RECEIVABLE_CREATED: { title: "待支付金额已确认", detail: "可在账户中心查看并完成支付。" },
  PAYMENT_EVIDENCE_RECORDED: { title: "支付信息已提交", detail: "支付信息正在确认。" },
  PAYMENT_EVIDENCE_ACCEPTED: { title: "支付信息已确认", detail: "已完成支付信息确认。" },
  PAYMENT_EVIDENCE_REJECTED: { title: "支付信息需要更新", detail: "请检查后重新提交。" },
  PAYMENT_APPROVED: { title: "支付结果已确认", detail: "账单正在完成结清。" },
  PAYMENT_REJECTED: { title: "支付结果需要确认", detail: "请检查支付信息后重试。" },
  STATEMENT_PAID: { title: "账单已结清", detail: "本期账单已经完成。" },
  NO_FEE_CLOSED: { title: "本期无需支付", detail: "本周期没有应付金额。" },
};

function StatementSummary({ statement }: { statement: PerformanceFeeStatement }) {
  const { locale, t } = useAppLocale();
  return <div className={styles.metrics} aria-label={t("模拟绩效账单摘要")}>
    <article><span>{t("本周模拟净收益")}</span><strong>{formatDecimal(statement.weeklyNetRealizedPnl, 6, locale)} USDT</strong><small>{t("已平仓 paper，扣除模拟手续费")}</small></article>
    <article><span>{t("计费基数")}</span><strong>{formatDecimal(statement.billableProfit, 6, locale)} USDT</strong><small>{t("高水位与亏损结转后")}</small></article>
    <article><span>{t("应收金额")}</span><strong>{formatDecimal(statement.feeAmount, 6, locale)} USDT</strong><small>{t("费率")} {(Number(statement.feeRate) * 100).toFixed(0)}%</small></article>
    <article><span>{t("当前状态")}</span><strong className={styles.statusValue}>{t(statementStatusLabels[statement.status])}</strong><small>{t("以当前账单为准")}</small></article>
  </div>;
}

function StatementList() {
  const { locale, t } = useAppLocale();
  const [cursorStack, setCursorStack] = useState([""]);
  const cursor = cursorStack.at(-1) ?? "";
  const url = useMemo(() => `/api/membership/performance-statements?limit=12${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, [cursor]);
  const resource = useApiData<CursorPage<PerformanceFeeStatement>>(url, t("绩效账单读取失败"));

  return <>
    <PageHeading
      eyebrow={t("模拟组合")}
      title={t("绩效账单")}
      description={t("按周期查看模拟组合收益、费用计算和支付状态。")}
      actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button>}
    />
    <div className={styles.boundary} role="note">
      {t("模拟收益不是真实投资收益。只有产生正向可计费收益时才会形成应付金额。")}
    </div>
    {resource.loading && !resource.data
      ? <LoadingState label={t("正在读取绩效账单…")} />
      : resource.error && !resource.data
        ? <ErrorState message={resource.error} retry={resource.refresh} />
        : !resource.data?.data.length
          ? <EmptyState title={t("暂无绩效账单")} description={t("没有产生可结算周期时不会伪造账单或收益数据。")} />
          : <section className={styles.list} aria-label={t("绩效账单列表")}>
            {resource.data.data.map((statement) => <article key={statement.id}>
              <div className={styles.itemTop}>
                <div><span>{t("账单周期")}</span><strong>{formatDateTime(statement.cycleStartedAt, locale)} — {formatDateTime(statement.cycleEndedAt, locale)}</strong></div>
                <StatusBadge value={t(statementStatusLabels[statement.status])} />
              </div>
              <div className={styles.itemValues}>
                <span>{t("模拟净收益")} <b>{formatDecimal(statement.weeklyNetRealizedPnl, 6, locale)} USDT</b></span>
                <span>{t("应收")} <b>{formatDecimal(statement.feeAmount, 6, locale)} USDT</b></span>
                <span>{t("亏损结转")} <b>{formatDecimal(statement.lossCarry, 6, locale)} USDT</b></span>
              </div>
              <div className={styles.itemFooter}>
                <small>{statement.replacesStatementId ? t("账单已更新") : t("按周期结算")}</small>
                <Link href={`/account-center?tab=statements&statement=${encodeURIComponent(statement.id)}`}>{t("查看详情")} <span aria-hidden="true">→</span></Link>
              </div>
            </article>)}
          </section>}
    {resource.data && (cursorStack.length > 1 || resource.data.page.hasMore) && <nav className={styles.pagination} aria-label={t("绩效账单分页")}>
      <button type="button" disabled={cursorStack.length === 1 || resource.loading} onClick={() => setCursorStack((items) => items.slice(0, -1))}>{t("上一页")}</button>
      <span>{t("第")} {cursorStack.length} {t("页")}</span>
      <button type="button" disabled={!resource.data.page.nextCursor || resource.loading} onClick={() => {
        const next = resource.data?.page.nextCursor;
        if (next) setCursorStack((items) => [...items, next]);
      }}>{t("下一页")}</button>
    </nav>}
  </>;
}

function StatementDetail({ statementId }: { statementId: string }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<ClientPerformanceStatementDetail>(
    `/api/membership/performance-statements/${encodeURIComponent(statementId)}`,
    t("绩效账单详情读取失败"),
  );
  const [paying, setPaying] = useState(false);
  const [payMessage, setPayMessage] = useState("");

  async function payFromWallet() {
    if (paying) return;
    setPaying(true);
    setPayMessage("");
    try {
      const response = await fetch(
        `/api/membership/performance-statements/${encodeURIComponent(statementId)}/pay-from-wallet`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // 幂等键在客户端生成：支付路径上网络重试是常态。
          body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.code === "WALLET_BALANCE_INSUFFICIENT"
          ? t("钱包余额不足，请先到「钱包」充值后再支付。")
          : String(payload.error ?? t("支付失败")));
      }
      setPayMessage(String(payload.message ?? t("账单已结清")));
      await resource.refresh();
    } catch (error) {
      setPayMessage(error instanceof Error ? error.message : t("支付失败"));
    } finally {
      setPaying(false);
    }
  }

  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取绩效账单…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message={t("绩效账单详情不可用")} retry={resource.refresh} />;
  const { statement, timeline } = resource.data;
  return <>
    {statement.status === "INVOICED" ? (
      <section className={styles.walletPayPanel}>
        <div>
          <strong>{t("应付")} {formatDecimal(statement.feeAmount, 6, locale)} USDT</strong>
          <p>{t("从钱包余额扣除，立即结清。余额不足时可先到「钱包」充值。")}</p>
        </div>
        <button type="button" className={styles.walletPay} disabled={paying} onClick={() => void payFromWallet()}>
          {paying ? t("扣款中…") : t("用余额支付")}
        </button>
        {payMessage ? <p role="status" className={styles.payMessage}>{payMessage}</p> : null}
      </section>
    ) : null}
    <PageHeading
      eyebrow={t("账单详情")}
      title={t("绩效账单详情")}
      description={`${formatDateTime(statement.cycleStartedAt, locale)} — ${formatDateTime(statement.cycleEndedAt, locale)}; ${t("金额单位为 USDT。")} `}
      actions={<><Link className="rc-button" href="/account-center?tab=statements">{t("返回列表")}</Link><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></>}
    />
    <StatementSummary statement={statement} />
    <section className={styles.panel} aria-labelledby="statement-basis-title">
      <header><div><span>{t("本期账单")}</span><h2 id="statement-basis-title">{t("费用计算")}</h2></div><StatusBadge value={t(statementStatusLabels[statement.status])} /></header>
      <dl className={styles.definitionGrid}>
        <div><dt>{t("累计模拟收益")}</dt><dd>{formatDecimal(statement.cumulativeNetRealizedPnl, 6, locale)} USDT</dd></div>
        <div><dt>{t("已结算收益基准")}</dt><dd>{formatDecimal(statement.settledHighWaterMark, 6, locale)} USDT</dd></div>
        <div><dt>{t("本期结算后收益基准")}</dt><dd>{formatDecimal(statement.highWaterMarkAfter, 6, locale)} USDT</dd></div>
        <div><dt>{t("模拟交易费用")}</dt><dd>{statement.simulatedFees === null ? t("暂无明细") : `${formatDecimal(statement.simulatedFees, 6, locale)} USDT`}</dd></div>
      </dl>
      {statement.status !== "PAID" && <p className={styles.lineage}>{t("本期结算后的收益基准会在账单结清后生效。")}</p>}
      {statement.replacesStatementId && <p className={styles.lineage}>{t("这份账单已根据最新核算结果更新。")}</p>}
    </section>
    <section className={styles.panel} aria-labelledby="strategy-breakdown-title">
      <header><div><span>{t("模拟组合")}</span><h2 id="strategy-breakdown-title">{t("策略收益明细")}</h2></div></header>
      {!statement.strategyBreakdown.length
        ? <EmptyState title={t("历史明细快照不可用")} description={t("保留账单汇总值，但不会补造缺失的三卡明细。")} />
        : <div className={styles.strategyList}>{statement.strategyBreakdown.map((item) => <article key={item.strategyCode}>
          <strong>{t(strategyLabel(item.strategyCode))}</strong>
          <span>{t("净已实现")} {formatDecimal(item.weeklyNetRealizedPnl, 6, locale)} USDT</span>
          <small>{t("毛已实现")} {formatDecimal(item.weeklyGrossRealizedPnl, 6, locale)} · {t("模拟手续费")} {formatDecimal(item.simulatedFees, 6, locale)}</small>
        </article>)}</div>}
    </section>
    <section className={styles.panel} aria-labelledby="timeline-title">
      <header><div><span>{t("账单状态")}</span><h2 id="timeline-title">{t("处理进度")}</h2></div><StatusBadge value={`${timeline.length} ${t("项")}`} /></header>
      {!timeline.length
        ? <EmptyState title={t("暂无处理记录")} description={t("账单更新后会在这里显示进度。")} />
        : <ol className={styles.timeline}>{timeline.map((event) => {
          const label = performanceStatementTimelineLabels[event.kind];
          return <li key={event.id}><span aria-hidden="true" /><div><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt, locale)}</time><h3>{t(label.title)}</h3><p>{t(label.detail)}</p></div></li>;
        })}</ol>}
    </section>
  </>;
}

export function PerformanceStatementsWorkspace({
  statementId,
}: {
  statementId?: string;
}) {
  return <>
    {statementId ? <StatementDetail statementId={statementId} /> : <StatementList />}
  </>;
}
