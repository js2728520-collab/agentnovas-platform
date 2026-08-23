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

import styles from "./performance-statements-workspace.module.css";

const statementStatusLabels: Record<PerformanceFeeStatement["status"], string> = {
  SUBMITTED: "等待业务审批",
  APPROVED: "业务审批已记录",
  REJECTED: "业务审核未通过",
  INVOICED: "等待外部付款复核",
  PAID: "外部付款已复核",
  CLOSED_NO_FEE: "本周期无需支付",
};

export const performanceStatementTimelineLabels: Record<
  PerformanceStatementTimelineEvent["kind"],
  { title: string; detail: string }
> = {
  STATEMENT_CREATED: { title: "账单已生成", detail: "已按上一完整 UTC 周汇总官方三卡 paper 模拟净收益。" },
  ASSESSMENT_APPROVED: { title: "业务审批已记录", detail: "审批只确认账单口径；不表示平台已收款。" },
  ASSESSMENT_REJECTED: { title: "业务审核未通过", detail: "当前版本未通过业务复核，后续修订会保留替代关系。" },
  RECEIVABLE_CREATED: { title: "应收已建立", detail: "已形成站内应收记录，不会自动扣款。" },
  PAYMENT_EVIDENCE_RECORDED: { title: "外部付款凭证已记录", detail: "凭证仍需由另一名 Operations checker 复核。" },
  PAYMENT_EVIDENCE_ACCEPTED: { title: "付款凭证已通过复核", detail: "仅确认受控外部凭证，不代表平台执行了支付。" },
  PAYMENT_EVIDENCE_REJECTED: { title: "付款凭证未通过复核", detail: "该凭证未被接受，账单状态以服务端为准。" },
  PAYMENT_APPROVED: { title: "付款复核决定已记录", detail: "复核通过后服务端才可提交结算高水位。" },
  PAYMENT_REJECTED: { title: "付款复核未通过", detail: "未执行退款、扣款或其他外部资金操作。" },
  STATEMENT_PAID: { title: "外部付款已复核完成", detail: "账单标记为已支付；平台未代客户执行外部支付。" },
  NO_FEE_CLOSED: { title: "本周期零费用关闭", detail: "未形成应收，也不会自动扣款。" },
};

function StatementSummary({ statement }: { statement: PerformanceFeeStatement }) {
  return <div className={styles.metrics} aria-label="paper 绩效账单摘要">
    <article><span>本周模拟净收益</span><strong>{formatDecimal(statement.weeklyNetRealizedPnl)} USDT</strong><small>已平仓 paper，扣除模拟手续费</small></article>
    <article><span>计费基数</span><strong>{formatDecimal(statement.billableProfit)} USDT</strong><small>高水位与亏损结转后</small></article>
    <article><span>应收金额</span><strong>{formatDecimal(statement.feeAmount)} USDT</strong><small>费率 {(Number(statement.feeRate) * 100).toFixed(0)}%</small></article>
    <article><span>当前状态</span><strong className={styles.statusValue}>{statementStatusLabels[statement.status]}</strong><small>修订 {statement.revision}</small></article>
  </div>;
}

function StatementList() {
  const [cursorStack, setCursorStack] = useState([""]);
  const cursor = cursorStack.at(-1) ?? "";
  const url = useMemo(() => `/api/membership/performance-statements?limit=12${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, [cursor]);
  const resource = useApiData<CursorPage<PerformanceFeeStatement>>(url, "绩效账单读取失败");

  return <>
    <PageHeading
      eyebrow="CLIENT · PAPER PERFORMANCE"
      title="绩效账单"
      description="按 UTC 自然周查看官方三卡 paper 已平仓模拟净收益、高水位、亏损结转和人工付款复核进度。"
      actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button>}
    />
    <div className={styles.boundary} role="note">
      paper 模拟收益不是真实投资收益。账单不会自动扣钱包；业务审批、外部付款凭证与付款复核是独立阶段。
    </div>
    {resource.loading && !resource.data
      ? <LoadingState label="正在读取绩效账单…" />
      : resource.error && !resource.data
        ? <ErrorState message={resource.error} retry={resource.refresh} />
        : !resource.data?.data.length
          ? <EmptyState title="暂无绩效账单" description="没有产生可结算周期时不会伪造账单或收益数据。" />
          : <section className={styles.list} aria-label="绩效账单列表">
            {resource.data.data.map((statement) => <article key={statement.id}>
              <div className={styles.itemTop}>
                <div><span>UTC 周期</span><strong>{formatDateTime(statement.cycleStartedAt)} — {formatDateTime(statement.cycleEndedAt)}</strong></div>
                <StatusBadge value={statementStatusLabels[statement.status]} />
              </div>
              <div className={styles.itemValues}>
                <span>模拟净收益 <b>{formatDecimal(statement.weeklyNetRealizedPnl)} USDT</b></span>
                <span>应收 <b>{formatDecimal(statement.feeAmount)} USDT</b></span>
                <span>亏损结转 <b>{formatDecimal(statement.lossCarry)} USDT</b></span>
              </div>
              <div className={styles.itemFooter}>
                <small>{statement.replacesStatementId ? `修订 ${statement.revision}，替代上一版本` : `修订 ${statement.revision}`}</small>
                <Link href={`/performance-statements/${encodeURIComponent(statement.id)}`}>查看证据链 <span aria-hidden="true">→</span></Link>
              </div>
            </article>)}
          </section>}
    {resource.data && (cursorStack.length > 1 || resource.data.page.hasMore) && <nav className={styles.pagination} aria-label="绩效账单分页">
      <button type="button" disabled={cursorStack.length === 1 || resource.loading} onClick={() => setCursorStack((items) => items.slice(0, -1))}>上一页</button>
      <span>第 {cursorStack.length} 页</span>
      <button type="button" disabled={!resource.data.page.nextCursor || resource.loading} onClick={() => {
        const next = resource.data?.page.nextCursor;
        if (next) setCursorStack((items) => [...items, next]);
      }}>下一页</button>
    </nav>}
  </>;
}

function StatementDetail({ statementId }: { statementId: string }) {
  const resource = useApiData<ClientPerformanceStatementDetail>(
    `/api/membership/performance-statements/${encodeURIComponent(statementId)}`,
    "绩效账单详情读取失败",
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
          ? "钱包余额不足，请先到「钱包」充值后再支付。"
          : String(payload.error ?? "支付失败"));
      }
      setPayMessage(String(payload.message ?? "账单已结清"));
      await resource.refresh();
    } catch (error) {
      setPayMessage(error instanceof Error ? error.message : "支付失败");
    } finally {
      setPaying(false);
    }
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取绩效账单证据链…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message="绩效账单详情不可用" retry={resource.refresh} />;
  const { statement, timeline } = resource.data;
  return <>
    {statement.status === "INVOICED" ? (
      <section className={styles.walletPayPanel}>
        <div>
          <strong>应付 {formatDecimal(statement.feeAmount)} USDT</strong>
          <p>从钱包余额扣除，立即结清。余额不足时可先到「钱包」充值。</p>
        </div>
        <button type="button" className={styles.walletPay} disabled={paying} onClick={() => void payFromWallet()}>
          {paying ? "扣款中…" : "用余额支付"}
        </button>
        {payMessage ? <p role="status" className={styles.payMessage}>{payMessage}</p> : null}
      </section>
    ) : null}
    <PageHeading
      eyebrow={`PAPER PERFORMANCE · REVISION ${statement.revision}`}
      title="绩效账单详情"
      description={`${formatDateTime(statement.cycleStartedAt)} — ${formatDateTime(statement.cycleEndedAt)}；所有金额均为 USDT paper 模拟口径。`}
      actions={<><Link className="rc-button" href="/performance-statements">返回列表</Link><button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button></>}
    />
    <StatementSummary statement={statement} />
    <section className={styles.panel} aria-labelledby="statement-basis-title">
      <header><div><span>SETTLEMENT BASIS</span><h2 id="statement-basis-title">结算口径</h2></div><StatusBadge value={statementStatusLabels[statement.status]} /></header>
      <dl className={styles.definitionGrid}>
        <div><dt>累计模拟净收益</dt><dd>{formatDecimal(statement.cumulativeNetRealizedPnl)} USDT</dd></div>
        <div><dt>当前已提交高水位</dt><dd>{formatDecimal(statement.settledHighWaterMark)} USDT</dd></div>
        <div><dt>{statement.status === "PAID" ? "本账单已提交高水位" : "付款复核通过后预计高水位"}</dt><dd>{formatDecimal(statement.highWaterMarkAfter)} USDT</dd></div>
        <div><dt>模拟手续费</dt><dd>{statement.simulatedFees === null ? "历史快照不可用" : `${formatDecimal(statement.simulatedFees)} USDT`}</dd></div>
      </dl>
      {statement.status !== "PAID" && <p className={styles.lineage}>预计高水位尚未提交；只有外部付款凭证通过双人复核并将账单标记为已支付后，才会成为后续周期的已结算高水位。</p>}
      {statement.replacesStatementId && <p className={styles.lineage}>本账单替代上一修订版本；旧版本保持不可变并留存审计关系。</p>}
    </section>
    <section className={styles.panel} aria-labelledby="strategy-breakdown-title">
      <header><div><span>OFFICIAL THREE-CARD SNAPSHOT</span><h2 id="strategy-breakdown-title">三卡周度明细</h2></div></header>
      {!statement.strategyBreakdown.length
        ? <EmptyState title="历史明细快照不可用" description="保留账单汇总值，但不会补造缺失的三卡明细。" />
        : <div className={styles.strategyList}>{statement.strategyBreakdown.map((item) => <article key={item.strategyCode}>
          <strong>{item.strategyCode}</strong>
          <span>净已实现 {formatDecimal(item.weeklyNetRealizedPnl)} USDT</span>
          <small>毛已实现 {formatDecimal(item.weeklyGrossRealizedPnl)} · 模拟手续费 {formatDecimal(item.simulatedFees)}</small>
        </article>)}</div>}
    </section>
    <section className={styles.panel} aria-labelledby="timeline-title">
      <header><div><span>IMMUTABLE TIMELINE</span><h2 id="timeline-title">状态证据链</h2></div><StatusBadge value={`${timeline.length} 个事件`} /></header>
      {!timeline.length
        ? <EmptyState title="暂无时间线事件" description="服务端尚未返回可验证事件。" />
        : <ol className={styles.timeline}>{timeline.map((event) => {
          const label = performanceStatementTimelineLabels[event.kind];
          return <li key={event.id}><span aria-hidden="true" /><div><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time><h3>{label.title}</h3><p>{label.detail}</p></div></li>;
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
