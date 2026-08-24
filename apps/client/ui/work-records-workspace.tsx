"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import type {
  StrategyWorkRecordAdmissionStatus,
  StrategyWorkRecordDetail,
  StrategyWorkRecordEvent,
  StrategyWorkRecordPage,
  StrategyWorkRecordSummary,
} from "@/packages/contracts/src/strategy-work-records";
import { apiErrorMessage, formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

import styles from "./work-records-workspace.module.css";

const PAGE_LIMIT = 20;

// 准入状态的文案必须逐一区分。把 not_recorded 和 not_required 合并成「无」会让
// 「本轮不需要准入」和「这一轮没有留下准入记录」看起来一样——前者是产品规则，
// 后者是证据缺失（INV-6）。
const admissionLabels: Record<StrategyWorkRecordAdmissionStatus, string> = {
  not_required: "本轮无需准入",
  not_recorded: "未记录准入",
  recorded: "已记录准入",
  risk_rejected: "风控拒绝",
  failed: "准入失败",
};

const admissionDescriptions: Record<StrategyWorkRecordAdmissionStatus, string> = {
  not_required: "公共结论为 hold 且本轮没有产生组合周期，因此不需要逐组合准入记录。",
  not_recorded: "本轮没有查到属于你的组合准入记录。这不表示无需准入，也不表示已经执行。",
  recorded: "已按你的组合单独计算准入，风险读数取自你自己的组合状态。",
  risk_rejected: "确定性风控拒绝了本轮新开仓。风控结论不可被任何模型覆盖。",
  failed: "准入过程失败，本轮未产生新开仓。",
};

const completenessLabels: Record<StrategyWorkRecordDetail["completeness"], string> = {
  complete: "七阶段完整",
  partial: "阶段不完整",
  legacy: "历史事件",
};

const executionModeLabels: Record<StrategyWorkRecordDetail["executionMode"], string> = {
  shadow: "影子记录",
  paper: "Paper 模拟",
};

function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return JSON.stringify(value);
}

function WorkRecordListItem({ record }: { record: StrategyWorkRecordSummary }) {
  return <article>
    <div className={styles.itemTop}>
      <div>
        <span>{record.strategyCode} · {record.strategyVersion}</span>
        <strong>{record.strategyName} · {record.symbol} · {record.timeframe}</strong>
      </div>
      <StatusBadge value={record.decisionStatus} />
    </div>
    <div className={styles.itemValues}>
      <span>组合准入 <b>{admissionLabels[record.admissionStatus]}</b></span>
      <span>执行模式 <b>{executionModeLabels[record.executionMode]}</b></span>
      <span>完整性 <b>{completenessLabels[record.completeness]}</b></span>
    </div>
    <div className={styles.itemFooter}>
      <small>
        {formatDateTime(record.occurredAt)}
        ．{record.isSharedDecision ? "公共决策轮" : "组合独有记录"}
        ．{record.hasOrderIntent ? "有模拟意图" : "无模拟意图"}
        ．{record.hasFillReceipt ? "有模拟成交" : "无模拟成交"}
      </small>
      <Link href={`/work-records/${encodeURIComponent(record.recordId)}`}>查看决策详情 <span aria-hidden="true">→</span></Link>
    </div>
  </article>;
}

/**
 * 「加载更多」而不是页码：游标是服务端编码的不透明位置，跳页没有意义，
 * 调用方也不得自己构造。
 *
 * 这里没有复用 `useApiData`，因为它每次取数都替换整个结果，而追加分页需要累积；
 * 把累积放进 effect 会变成「effect 里同步 setState」。取消、序号防陈旧和 401
 * 跳转的处理与 `useApiData` 保持一致。
 */
function useWorkRecordFeed() {
  const [records, setRecords] = useState<StrategyWorkRecordSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (cursor: string) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const url = `/api/work-records?limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (sequence !== requestSequence.current) return;
      if (response.status === 401) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (!response.ok) throw new Error(apiErrorMessage(payload, "工作记录读取失败"));
      const page = payload as StrategyWorkRecordPage;
      // 无游标即第一页，整体替换；有游标则追加。按 recordId 去重，
      // 让「不重复、不跳项」不依赖服务端游标在边界上的行为。
      setRecords((previous) => {
        if (!cursor) return page.data;
        const seen = new Set(previous.map((item) => item.recordId));
        return [...previous, ...page.data.filter((item) => !seen.has(item.recordId))];
      });
      setNextCursor(page.page.nextCursor);
    } catch (reason) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : "工作记录读取失败");
    } finally {
      if (sequence === requestSequence.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(""), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [load]);

  return { records, nextCursor, loading, error, load };
}

function WorkRecordList() {
  const { records, nextCursor, loading, error, load } = useWorkRecordFeed();
  const reload = useCallback(() => void load(""), [load]);

  return <>
    <PageHeading
      eyebrow="CLIENT · WORK RECORDS"
      title="工作记录"
      description="查看你订阅期间的历史决策轮：公共七阶段判断，加上你自己组合的准入、模拟订单意图与模拟成交。"
      actions={<button className="rc-button" type="button" onClick={reload}>刷新</button>}
    />
    <div className={styles.boundary} role="note">
      同一张策略卡在同一根已收盘 K 线上只判断一次，七阶段叙述由订阅该卡的所有客户共享；
      准入、模拟意图和模拟成交按你自己的组合单独计算。工作记录只解释已经发生并持久化的事实，
      不会重新调用模型，也不产生真实交易所订单。
    </div>
    {loading && !records.length
      ? <LoadingState label="正在读取工作记录…" />
      : error && !records.length
        ? <ErrorState message={error} retry={reload} />
        : !records.length
          ? <EmptyState title="暂无工作记录" description="你的订阅期间内还没有已收盘的决策轮。系统不会补造历史记录。" />
          : <>
            <section className={styles.list} aria-label="工作记录列表">
              {records.map((record) => <WorkRecordListItem key={record.recordId} record={record} />)}
            </section>
            {/* 追加页失败时列表已有内容，错误必须单独可见，不能只靠上面的整页错误态。 */}
            {error ? <p role="alert" className={styles.note}>{error}</p> : null}
            <div className={styles.loadMore}>
              {nextCursor
                ? <button type="button" disabled={loading} onClick={() => void load(nextCursor)}>
                  {loading ? "正在加载…" : "加载更多"}
                </button>
                : <small>已经到底，共 {records.length} 条。</small>}
              <small aria-live="polite">{loading ? "正在读取下一页…" : `已加载 ${records.length} 条记录`}</small>
            </div>
          </>}
  </>;
}

function StageList({ events }: { events: StrategyWorkRecordEvent[] }) {
  if (!events.length) {
    return <EmptyState title="本轮没有留存阶段事件" description="缺失的阶段不会用静态结论补齐。" />;
  }
  return <ol className={styles.stages}>
    {events.map((event) => {
      const evidenceEntries = Object.entries(event.evidence);
      return <li key={`${event.sequence}-${event.role}`}>
        <div className={styles.stageTop}>
          <div>
            <h3>{event.name}</h3>
            <small>{event.outputName}</small>
          </div>
          <span className={styles.stageOrder}>第 {event.sequence} 阶段</span>
        </div>
        <p className={styles.stageConclusion}>{event.conclusion}</p>
        {event.explanation ? <p className={styles.stageExplanation}>{event.explanation}</p> : null}
        <div className={styles.stageMeta}>
          <span>{event.llmUsed ? "含 LLM 解释" : "确定性结论"}</span>
          <span>解释状态：{event.explanationStatus}</span>
          <span>{formatDateTime(event.createdAt)}</span>
        </div>
        {evidenceEntries.length
          ? <dl className={styles.evidence}>
            {evidenceEntries.map(([key, value]) => <div key={key}>
              <dt>{key}</dt>
              <dd>{formatEvidenceValue(value)}</dd>
            </div>)}
          </dl>
          : null}
      </li>;
    })}
  </ol>;
}

function WorkRecordDetail({ recordId }: { recordId: string }) {
  const resource = useApiData<StrategyWorkRecordDetail>(
    `/api/work-records/${encodeURIComponent(recordId)}`,
    "工作记录详情读取失败",
  );

  if (resource.loading && !resource.data) return <LoadingState label="正在读取工作记录详情…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message="工作记录详情不可用" retry={resource.refresh} />;

  const record = resource.data;
  const snapshot = record.marketSnapshot;
  const qualityEntries = snapshot ? Object.entries(snapshot.dataQuality) : [];

  return <>
    <PageHeading
      eyebrow={`WORK RECORD · ${record.strategyCode.toUpperCase()}`}
      title="工作记录详情"
      description={`${record.strategyName} · ${record.symbol} · ${record.timeframe}；K 线 ${formatDateTime(record.candleOpenAt)} — ${formatDateTime(record.occurredAt)}。`}
      actions={<><Link className="rc-button" href="/work-records">返回列表</Link><button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button></>}
    />

    <section className={styles.panel} aria-labelledby="public-decision-title">
      <header>
        <div><span>PUBLIC DECISION</span><h2 id="public-decision-title">公共决策</h2></div>
        <StatusBadge value={record.decisionStatus} />
      </header>
      <dl className={styles.definitionGrid}>
        <div><dt>策略名称与固定版本</dt><dd>{record.strategyName} · {record.strategyVersion}</dd></div>
        <div><dt>品种与周期</dt><dd>{record.symbol} · {record.timeframe}</dd></div>
        <div><dt>K 线开盘</dt><dd>{formatDateTime(record.candleOpenAt)}</dd></div>
        <div><dt>K 线收盘</dt><dd>{formatDateTime(record.occurredAt)}</dd></div>
        <div><dt>完整性</dt><dd>{completenessLabels[record.completeness]}</dd></div>
        <div><dt>执行模式</dt><dd>{executionModeLabels[record.executionMode]}</dd></div>
      </dl>
      <p className={styles.note}>
        {record.isSharedDecision
          ? "这是一轮公共决策：同一张策略卡在这根已收盘 K 线上只判断一次，七阶段叙述展示给订阅该卡的所有客户，其中不含任何客户数据。"
          : "这是一条组合独有的历史记录，没有对应的共享决策轮。"}
      </p>
    </section>

    <section className={styles.panel} aria-labelledby="market-snapshot-title">
      <header>
        <div><span>MARKET SNAPSHOT</span><h2 id="market-snapshot-title">行情摘要</h2></div>
        {snapshot ? <StatusBadge value={`${snapshot.candleCount} 根 K 线`} /> : null}
      </header>
      {!snapshot
        ? <EmptyState title="本轮没有留存行情快照" description="不会用当前行情回填历史判断依据。" />
        : <>
          <dl className={styles.definitionGrid}>
            <div><dt>数据来源</dt><dd>{snapshot.exchange}</dd></div>
            <div><dt>标的与周期</dt><dd>{snapshot.symbol} · {snapshot.timeframe}</dd></div>
            <div><dt>数据起点</dt><dd>{formatDateTime(snapshot.dataStart)}</dd></div>
            <div><dt>数据终点</dt><dd>{formatDateTime(snapshot.dataEnd)}</dd></div>
            <div><dt>K 线数量</dt><dd>{snapshot.candleCount}</dd></div>
            <div><dt>数据集摘要</dt><dd className={styles.mono}>{snapshot.datasetSha256}</dd></div>
          </dl>
          {qualityEntries.length
            ? <dl className={styles.evidence} aria-label="数据质量">
              {qualityEntries.map(([key, value]) => <div key={key}>
                <dt>{key}</dt>
                <dd>{formatEvidenceValue(value)}</dd>
              </div>)}
            </dl>
            : null}
        </>}
    </section>

    <section className={styles.panel} aria-labelledby="stages-title">
      <header>
        <div><span>SEVEN-STAGE CHAIN</span><h2 id="stages-title">七阶段决策链</h2></div>
        <StatusBadge value={completenessLabels[record.completeness]} />
      </header>
      <StageList events={record.events} />
    </section>

    <section className={styles.panel} aria-labelledby="admission-title">
      <header>
        <div><span>YOUR PORTFOLIO ADMISSION</span><h2 id="admission-title">你的组合准入</h2></div>
        <StatusBadge value={admissionLabels[record.admission.status]} />
      </header>
      <p className={styles.stageConclusion}>{admissionDescriptions[record.admission.status]}</p>
      <dl className={styles.definitionGrid}>
        <div><dt>周期状态</dt><dd>{record.admission.cycleStatus ?? "—"}</dd></div>
        <div><dt>完成时间</dt><dd>{formatDateTime(record.admission.completedAt)}</dd></div>
      </dl>
      {record.admission.decision && Object.keys(record.admission.decision).length
        ? <dl className={styles.evidence} aria-label="准入风险摘要">
          {Object.entries(record.admission.decision).map(([key, value]) => <div key={key}>
            <dt>{key}</dt>
            <dd>{formatEvidenceValue(value)}</dd>
          </div>)}
        </dl>
        : null}
    </section>

    <section className={styles.panel} aria-labelledby="intents-title">
      <header>
        <div><span>SIMULATED INTENTS</span><h2 id="intents-title">模拟订单意图</h2></div>
        <StatusBadge value={`${record.orderIntents.length} 条`} />
      </header>
      {!record.orderIntents.length
        ? <EmptyState title="本轮没有产生模拟订单意图" description="没有意图不等于被拒绝；原因见上方阶段结论。" />
        /* jsx-a11y 不允许非交互元素带 tabIndex，而 axe 的 scrollable-region-focusable
           要求可滚动区域必须能被键盘聚焦。两条规则在这里冲突，以实际行为为准：
           窄屏下这张表要横向滚动，没有 tabIndex 用键盘就读不到右侧的列。 */
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        : <div className={styles.tableScroll} tabIndex={0} role="region" aria-labelledby="intents-title">
          <table className={styles.dataTable}>
            <thead><tr><th>动作</th><th>执行时机</th><th>请求价格</th><th>状态</th><th>拒绝原因</th><th>创建时间</th><th>成交时间</th></tr></thead>
            <tbody>{record.orderIntents.map((intent) => <tr key={intent.id}>
              <td>{intent.action === "buy" ? "买入" : "卖出"}</td>
              <td>{intent.executionTiming}</td>
              <td>{intent.requestedPrice === null ? "—" : formatDecimal(intent.requestedPrice)}</td>
              <td>{intent.status}</td>
              <td>{intent.rejectionCode ?? "—"}</td>
              <td>{formatDateTime(intent.createdAt)}</td>
              <td>{formatDateTime(intent.filledAt)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
    </section>

    <section className={styles.panel} aria-labelledby="fills-title">
      <header>
        <div><span>SIMULATED FILLS</span><h2 id="fills-title">模拟成交回执</h2></div>
        <StatusBadge value={`${record.fillReceipts.length} 条`} />
      </header>
      {!record.fillReceipts.length
        ? <EmptyState title="本轮没有模拟成交" description="Paper 成交由服务器按组合现金、持仓和已审批意图记账生成。" />
        /* jsx-a11y 不允许非交互元素带 tabIndex，而 axe 的 scrollable-region-focusable
           要求可滚动区域必须能被键盘聚焦。两条规则在这里冲突，以实际行为为准：
           窄屏下这张表要横向滚动，没有 tabIndex 用键盘就读不到右侧的列。 */
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        : <div className={styles.tableScroll} tabIndex={0} role="region" aria-labelledby="fills-title">
          <table className={styles.dataTable}>
            <thead><tr><th>动作</th><th>数量</th><th>成交价</th><th>名义金额</th><th>手续费</th><th>已实现毛盈亏</th><th>已实现净盈亏</th><th>成交时间</th></tr></thead>
            <tbody>{record.fillReceipts.map((fill) => <tr key={fill.id}>
              <td>{fill.action === "buy" ? "买入" : "卖出"}</td>
              <td>{formatDecimal(fill.quantity)}</td>
              <td>{formatDecimal(fill.fillPrice)}</td>
              <td>{formatDecimal(fill.notionalUsdt)} USDT</td>
              <td>{formatDecimal(fill.feeUsdt)} USDT</td>
              <td>{formatDecimal(fill.realizedGrossPnlUsdt)} USDT</td>
              <td>{formatDecimal(fill.realizedNetPnlUsdt)} USDT</td>
              <td>{formatDateTime(fill.filledAt)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      <p className={styles.note}>
        以上是 Paper 模拟成交，不是真实交易所成交，盈亏不可提取。本平台当前不路由真实订单
        （realOrderRoutingEnabled = {String(record.realOrderRoutingEnabled)}）。
      </p>
    </section>

    <section className={styles.panel} aria-labelledby="audit-title">
      <header><div><span>AUDIT BOUNDARY</span><h2 id="audit-title">审计标识与边界</h2></div></header>
      <dl className={styles.definitionGrid}>
        <div><dt>记录 ID</dt><dd className={styles.mono}>{record.recordId}</dd></div>
        <div><dt>共享决策轮 ID</dt><dd className={styles.mono}>{record.sharedDecisionRoundId ?? "—"}</dd></div>
        <div><dt>Trace ID</dt><dd className={styles.mono}>{record.traceId ?? "—"}</dd></div>
      </dl>
      <p className={styles.note}>
        Trace 只是审计关联标识，不暴露请求体或错误原文。工作记录至少保留六个月。
      </p>
    </section>
  </>;
}

export function WorkRecordsWorkspace({ recordId }: { recordId?: string }) {
  return recordId ? <WorkRecordDetail recordId={recordId} /> : <WorkRecordList />;
}

export default WorkRecordsWorkspace;
