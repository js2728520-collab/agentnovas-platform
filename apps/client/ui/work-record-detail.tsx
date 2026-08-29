"use client";

import Link from "next/link";

import type {
  StrategyWorkRecordDetail,
  StrategyWorkRecordEvent,
} from "@/packages/contracts/src/strategy-work-records";
import { formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { useApiData } from "@/packages/ui/src/use-api-data";

import {
  strategyWorkRecordAdmissionPresentation,
  localizeStrategyWorkRecordLabel,
  strategyWorkRecordCompletenessLabel,
  strategyWorkRecordDecisionLabel,
  strategyWorkRecordEvidenceRows,
  strategyWorkRecordExecutionModeLabel,
} from "./work-record-presentation";
import styles from "./work-records-workspace.module.css";

function EvidenceList({ evidence, empty = "本阶段没有可公开的补充证据。" }: {
  evidence: Record<string, unknown> | null;
  empty?: string;
}) {
  const { t } = useAppLocale();
  const rows = evidence ? strategyWorkRecordEvidenceRows(evidence) : [];
  if (!rows.length) return <p className={styles.muted}>{t(empty)}</p>;
  return <dl className={styles.evidenceList}>{rows.map((row, index) => <div key={`${row.label}-${index}`}>
    <dt>{row.label.split(" · ").map(t).join(" · ")}</dt><dd>{t(row.value)}</dd>
  </div>)}</dl>;
}

function DecisionStage({ event }: { event: StrategyWorkRecordEvent }) {
  const { locale, t } = useAppLocale();
  return <li className={styles.stage}>
    <div className={styles.stageSequence} aria-hidden="true">{event.sequence}</div>
    <article>
      <header>
        <div><span>{t(event.outputName)}</span><h3>{t(event.name)}</h3></div>
        <StatusBadge value={event.llmUsed ? `${t("模型解释")}${event.explanation ? t("已完成") : t("未完成")}` : t("确定性阶段")} />
      </header>
      <p className={styles.conclusion}>{event.conclusion || t("本阶段没有公开结论。")}</p>
      <EvidenceList evidence={event.evidence} />
      {event.explanation ? <aside className={styles.explanation}>
        <strong>{t("公开模型解释")}</strong><p>{event.explanation}</p>
      </aside> : null}
      <time dateTime={event.createdAt}>{t("记录于")} {formatDateTime(event.createdAt, locale)}</time>
    </article>
  </li>;
}

function WorkRecordTables({ record }: { record: StrategyWorkRecordDetail }) {
  const { locale, t } = useAppLocale();
  return <section className={styles.panel} aria-labelledby="work-record-execution-title">
    <header><div><span>PAPER EXECUTION</span><h2 id="work-record-execution-title">{t("模拟意图与成交")}</h2></div><StatusBadge value={t("真实订单关闭")} /></header>
    {!record.orderIntents.length
      ? <EmptyState title={t("没有模拟订单意图")} description={t("本轮未形成该组合的模拟订单意图；不会因此推断为真实下单或成交。")} />
      // 横向表格需要可聚焦，确保键盘用户可以滚动到视口外的列。
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      : <div className={styles.tableRegion} role="region" aria-label={t("模拟订单意图")} tabIndex={0}>
        <table><thead><tr><th>{t("动作")}</th><th>{t("执行时机")}</th><th>{t("请求价格")}</th><th>{t("状态")}</th><th>{t("拒绝码")}</th><th>{t("创建时间")}</th></tr></thead>
          <tbody>{record.orderIntents.map((intent) => <tr key={intent.id}>
            <td>{intent.action === "buy" ? t("模拟买入") : t("模拟卖出")}</td>
            <td>{intent.executionTiming}</td><td>{intent.requestedPrice ?? t("未记录")}</td><td>{intent.status}</td>
            <td>{intent.rejectionCode ?? "—"}</td><td>{formatDateTime(intent.createdAt, locale)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    <h3 className={styles.subheading}>{t("Paper 模拟成交回执")}</h3>
    {!record.fillReceipts.length
      ? <p className={styles.muted}>{t("本轮没有模拟成交回执。")}</p>
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      : <div className={styles.tableRegion} role="region" aria-label={t("Paper 模拟成交回执")} tabIndex={0}>
        <table><thead><tr><th>{t("动作")}</th><th>{t("数量")}</th><th>{t("成交价")}</th><th>{t("名义金额")}</th><th>{t("模拟费用")}</th><th>{t("净损益")}</th><th>{t("成交时间")}</th></tr></thead>
          <tbody>{record.fillReceipts.map((fill) => <tr key={fill.id}>
            <td>{fill.action === "buy" ? t("模拟买入") : t("模拟卖出")}</td><td>{formatDecimal(fill.quantity, 6, locale)}</td>
            <td>{formatDecimal(fill.fillPrice, 6, locale)}</td><td>{formatDecimal(fill.notionalUsdt, 6, locale)} USDT</td>
            <td>{formatDecimal(fill.feeUsdt, 6, locale)} USDT</td><td>{formatDecimal(fill.realizedNetPnlUsdt, 6, locale)} USDT</td>
            <td>{formatDateTime(fill.filledAt, locale)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
  </section>;
}

function WorkRecordContent({ record }: { record: StrategyWorkRecordDetail }) {
  const { locale, t } = useAppLocale();
  const admission = strategyWorkRecordAdmissionPresentation(record.admission.status);
  return <>
    <PageHeading
      eyebrow="CLIENT · IMMUTABLE WORK RECORD"
      title={t("工作记录详情")}
      description={`${record.strategyName} · ${record.symbol} · ${record.timeframe} · ${formatDateTime(record.occurredAt, locale)}`}
      actions={<><Link className="rc-button" href="/trading?tab=records">{t("返回列表")}</Link></>}
    />
    <aside className={styles.boundary} role="note">
      <strong>{t(record.isSharedDecision ? "这是该策略卡的公共决策轮。" : "这是迁移前的历史客户周期。")}</strong>
      <span>{t("公共七阶段不含客户数据；“你的组合准入”和 Paper 模拟结果只来自当前账户的订阅期间与部署链。真实订单路由保持关闭。")}</span>
    </aside>

    <section className={styles.summaryGrid} aria-label={t("工作记录摘要")}>
      <article><span>{t("固定策略版本")}</span><strong>{record.strategyVersion}</strong><small>{record.strategyCode}</small></article>
      <article><span>{t("公共决策")}</span><strong>{localizeStrategyWorkRecordLabel(strategyWorkRecordDecisionLabel(record.decisionStatus), t)}</strong><small>{t(strategyWorkRecordCompletenessLabel(record.completeness))}</small></article>
      <article><span>{t("执行环境")}</span><strong>{t(strategyWorkRecordExecutionModeLabel(record.executionMode))}</strong><small>{t("不连接真实订单路由")}</small></article>
      <article><span>{t("你的组合准入")}</span><strong>{t(admission.label)}</strong><small>{record.admission.completedAt ? formatDateTime(record.admission.completedAt, locale) : t("无完成时间")}</small></article>
    </section>

    <section className={styles.panel} aria-labelledby="work-record-market-title">
      <header><div><span>MARKET SNAPSHOT</span><h2 id="work-record-market-title">{t("行情摘要")}</h2></div></header>
      {!record.marketSnapshot
        ? <EmptyState title={t("行情摘要不可用")} description={t("保留决策记录，但不会补造缺失的历史行情证据。")} />
        : <>
          <dl className={styles.definitionGrid}>
            <div><dt>{t("来源")}</dt><dd>{record.marketSnapshot.exchange}</dd></div>
            <div><dt>{t("标的与周期")}</dt><dd>{record.marketSnapshot.symbol} · {record.marketSnapshot.timeframe}</dd></div>
            <div><dt>{t("数据区间")}</dt><dd>{formatDateTime(record.marketSnapshot.dataStart, locale)} — {formatDateTime(record.marketSnapshot.dataEnd, locale)}</dd></div>
            <div><dt>{t("K 线数量")}</dt><dd>{record.marketSnapshot.candleCount}</dd></div>
            <div className={styles.wide}><dt>{t("数据集摘要")}</dt><dd><code>{record.marketSnapshot.datasetSha256}</code></dd></div>
          </dl>
          <EvidenceList evidence={record.marketSnapshot.dataQuality} empty="没有可公开的数据质量摘要。" />
        </>}
    </section>

    <section className={styles.panel} aria-labelledby="work-record-stages-title">
      <header><div><span>SEVEN-STAGE RECORD</span><h2 id="work-record-stages-title">{t("七阶段工作记录")}</h2></div><StatusBadge value={`${record.events.length} ${t("个阶段")}`} /></header>
      {!record.events.length
        ? <EmptyState title={t("阶段记录不可用")} description={t("历史或不完整记录可能缺少阶段事件；系统不会生成替代结论。")} />
        // 可滚动区域需要可聚焦，确保键盘用户可以读取超出视口的全部阶段。
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        : <div className={styles.stageRegion} role="region" aria-label={t("七阶段工作记录")} tabIndex={0}>
          <ol className={styles.stageList}>{record.events.map((event) => <DecisionStage key={`${event.sequence}-${event.role}`} event={event} />)}</ol>
        </div>}
    </section>

    <section className={styles.panel} aria-labelledby="work-record-admission-title">
      <header><div><span>YOUR PORTFOLIO</span><h2 id="work-record-admission-title">{t("你的组合准入")}</h2></div><StatusBadge value={t(admission.label)} /></header>
      <p className={styles.panelLead}>{t(admission.detail)}</p>
      <EvidenceList evidence={record.admission.decision} empty="本轮没有该组合的确定性准入明细。" />
    </section>

    <WorkRecordTables record={record} />

    <section className={styles.panel} aria-labelledby="work-record-audit-title">
      <header><div><span>AUDIT BOUNDARY</span><h2 id="work-record-audit-title">{t("审计边界")}</h2></div></header>
      <dl className={styles.definitionGrid}>
        <div className={styles.wide}><dt>{t("工作记录标识")}</dt><dd><code>{record.recordId}</code></dd></div>
        <div><dt>{t("记录类型")}</dt><dd>{t(record.sharedDecisionRoundId ? "公共决策轮" : "历史客户周期")}</dd></div>
        <div><dt>{t("审计关联标识")}</dt><dd><code>{record.traceId ?? t("未记录")}</code></dd></div>
        <div><dt>{t("真实订单路由")}</dt><dd>{record.realOrderRoutingEnabled ? t("已开启") : t("已关闭")}</dd></div>
        <div><dt>{t("K 线开收盘")}</dt><dd>{formatDateTime(record.candleOpenAt, locale)} — {formatDateTime(record.occurredAt, locale)}</dd></div>
      </dl>
      <p className={styles.panelLead}>{t("页面只展示服务端安全投影，不包含客户标识、交易所账户、原始模型内容、隐藏提示词、供应商凭证或错误原文。")}</p>
    </section>
  </>;
}

export function WorkRecordDetail({ recordId }: { recordId: string }) {
  const { t } = useAppLocale();
  const resource = useApiData<StrategyWorkRecordDetail>(
    `/api/work-records/${encodeURIComponent(recordId)}`,
    t("工作记录详情读取失败"),
  );
  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取工作记录详情…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message={t("工作记录详情不可用")} retry={resource.refresh} />;
  return <WorkRecordContent record={resource.data} />;
}
