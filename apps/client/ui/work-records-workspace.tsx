"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  StrategyWorkRecordPage,
  StrategyWorkRecordSummary,
} from "@/packages/contracts/src/strategy-work-records";
import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import {
  strategyWorkRecordAdmissionPresentation,
  localizeStrategyWorkRecordLabel,
  strategyWorkRecordCompletenessLabel,
  strategyWorkRecordDecisionLabel,
  strategyWorkRecordExecutionModeLabel,
} from "./work-record-presentation";
import { WorkRecordDetail } from "./work-record-detail";
import styles from "./work-records-workspace.module.css";

function useWorkRecordList() {
  const { t } = useAppLocale();
  const [items, setItems] = useState<StrategyWorkRecordSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [failedRequest, setFailedRequest] = useState<{ cursor: string | null; append: boolean } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    activeRequest.current = controller;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError("");
    setFailedRequest(null);
    try {
      const url = `/api/work-records?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (sequence !== requestSequence.current) return;
      if (response.status === 401) {
        window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      if (!response.ok) throw new Error(apiErrorMessage(payload, t("工作记录读取失败")));
      const page = payload as StrategyWorkRecordPage;
      setItems((current) => {
        if (!append) return page.data;
        const existing = new Set(current.map((item) => item.recordId));
        return [...current, ...page.data.filter((item) => !existing.has(item.recordId))];
      });
      setNextCursor(page.page.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : t("工作记录读取失败"));
        setFailedRequest({ cursor, append });
      }
    } finally {
      if (sequence === requestSequence.current) {
        activeRequest.current = null;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(null, false), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [load]);

  return {
    items,
    nextCursor,
    loading,
    loadingMore,
    error,
    refresh: () => load(null, false),
    loadMore: () => nextCursor ? load(nextCursor, true) : Promise.resolve(),
    retry: () => failedRequest ? load(failedRequest.cursor, failedRequest.append) : load(null, false),
  };
}

function WorkRecordCard({ record }: { record: StrategyWorkRecordSummary }) {
  const { locale, t } = useAppLocale();
  const admission = strategyWorkRecordAdmissionPresentation(record.admissionStatus);
  return <article className={styles.recordCard}>
    <header>
      <div>
        <time dateTime={record.occurredAt}>{formatDateTime(record.occurredAt, locale)}</time>
        <h2>{record.strategyName}</h2>
        <p>{record.symbol} · {record.timeframe} · {t("固定版本")} {record.strategyVersion}</p>
      </div>
      <StatusBadge value={localizeStrategyWorkRecordLabel(strategyWorkRecordDecisionLabel(record.decisionStatus), t)} />
    </header>
    <dl className={styles.cardFacts}>
      <div><dt>{t("决策记录")}</dt><dd>{t(record.isSharedDecision ? "本卡公共决策轮" : "历史客户周期")}</dd></div>
      <div><dt>{t("阶段完整性")}</dt><dd>{t(strategyWorkRecordCompletenessLabel(record.completeness))}</dd></div>
      <div><dt>{t("执行环境")}</dt><dd>{t(strategyWorkRecordExecutionModeLabel(record.executionMode))}</dd></div>
      <div><dt>{t("你的组合准入")}</dt><dd>{t(admission.label)}</dd></div>
    </dl>
    <footer>
      <p>{record.hasFillReceipt
        ? t("已有 Paper 模拟成交回执")
        : record.hasOrderIntent
          ? t("已有模拟订单意图，尚无成交回执")
          : t("本轮没有模拟订单意图或成交")}</p>
      <Link href={`/trading?tab=records&record=${encodeURIComponent(record.recordId)}`}>{t("查看完整记录")} <span aria-hidden="true">→</span></Link>
    </footer>
  </article>;
}

function WorkRecordList() {
  const { t } = useAppLocale();
  const resource = useWorkRecordList();
  return <>
    <PageHeading
      eyebrow="CLIENT · DECISION EVIDENCE"
      title={t("工作记录")}
      description={t("回看订阅期间的公共七阶段判断、固定策略版本，以及只属于你的组合准入和 Paper 模拟执行事实。")}
      actions={<button className="rc-button" type="button" disabled={resource.loading || resource.loadingMore} onClick={() => void resource.refresh()}>{t("刷新")}</button>}
    />
    <aside className={styles.boundary} role="note">
      <strong>{t("公共判断与个人准入分开记录。")}</strong>
      <span>{t("同一策略卡在同一根已收盘 K 线上的七阶段结论对订阅者共享；仓位、风控准入、模拟意图和成交按你的组合单独判定。真实订单路由保持关闭。")}</span>
    </aside>

    {resource.loading && !resource.items.length
      ? <LoadingState label={t("正在读取工作记录…")} />
      : resource.error && !resource.items.length
        ? <ErrorState message={resource.error} retry={resource.retry} />
        : !resource.items.length
          ? <EmptyState title={t("暂无工作记录")} description={t("订阅期间产生公共决策轮后才会显示；系统不会补造缺失历史或演示成交。")} />
          : <section className={styles.recordList} aria-label={t("策略工作记录列表")}>
            {resource.items.map((record) => <WorkRecordCard key={record.recordId} record={record} />)}
          </section>}

    {resource.error && resource.items.length > 0 ? <div className={styles.inlineError} role="alert">
      <span>{resource.error}</span>
      <button type="button" onClick={() => void resource.retry()}>{t("重新读取")}</button>
    </div> : null}

    {resource.nextCursor ? <div className={styles.loadMore}>
      <button type="button" disabled={resource.loadingMore} onClick={() => void resource.loadMore()}>
        {resource.loadingMore ? t("正在加载…") : t("加载更多")}
      </button>
    </div> : resource.items.length > 0 ? <p className={styles.endNote} role="status">{t("已显示全部可见记录")}</p> : null}
  </>;
}

export function WorkRecordsWorkspace({ recordId }: { recordId?: string }) {
  return recordId ? <WorkRecordDetail recordId={recordId} /> : <WorkRecordList />;
}
