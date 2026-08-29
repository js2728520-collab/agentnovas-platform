"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import type { UserAppLocale } from "@/lib/user-app-preference";

type UsageMetrics = {
  requestCount: number;
  succeededCount: number;
  recordedFailureCount: number;
  cancelledCount: number;
  processingCount: number;
  inputTokens: string;
  outputTokens: string;
  settledCredits: string;
  releasedCount: number;
  recordedFailureRate: number | null;
  organizationAttribution: {
    capturedAtRequest: number;
    legacyCurrentBackfill: number;
    legacyUnattributed: number;
  };
};

type UsageGroup = UsageMetrics & { key: string; label?: string };
type UsageModelGroup = UsageGroup & { providerName: string; modelName: string };
type BoundedGroups<T> = { data: T[]; truncated: boolean };
type UsageReport = {
  period: { from: string; to: string; timezone: "UTC" };
  timeBasis: "request_created_at";
  population: {
    included: "reserved_inference_requests";
    failureNumerator: "non_cancelled_failed_terminal_requests";
    excludes: readonly string[];
  };
  pricing: { status: "decision_required"; blocker: "P-08" };
  summary: UsageMetrics;
  byDay: UsageGroup[];
  byOrganization: BoundedGroups<UsageGroup>;
  byUser: BoundedGroups<UsageGroup>;
  byModel: BoundedGroups<UsageModelGroup>;
  byAgent: UsageGroup[];
  byFunction: UsageGroup[];
};

function currentUtcRange() {
  const today = new Date();
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function isValidDateInputValue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function exactInteger(value: string, locale: UserAppLocale) {
  try { return BigInt(value).toLocaleString(locale); } catch { return value; }
}

function addExactIntegers(left: string, right: string, locale: UserAppLocale, unavailable: string) {
  try { return (BigInt(left) + BigInt(right)).toLocaleString(locale); } catch { return unavailable; }
}

function failureRate(value: number | null, empty: string) {
  return value === null ? empty : `${(value * 100).toFixed(1)}%`;
}

function operationLabel(value: string, t: (text: string) => string) {
  if (value === "assistant_message") return t("AI 助手对话");
  if (value === "strategy_generation") return t("策略生成");
  if (value === "report") return `report · ${t("助手回答")}`;
  if (value === "proposal_a") return `proposal_a · ${t("策略提案")}`;
  return value;
}

export function AiUsageWorkspace() {
  const { locale, t } = useAppLocale();
  const manualRefreshPending = useRef(false);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [applied, setApplied] = useState({ from: "", to: "" });
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const defaults = currentUtcRange();
      const parameters = new URLSearchParams(window.location.search);
      const nextApplied = {
        from: parameters.get("from") || defaults.from,
        to: parameters.get("to") || defaults.to,
      };
      const nextDraft = isValidDateInputValue(nextApplied.from) && isValidDateInputValue(nextApplied.to)
        ? nextApplied
        : defaults;
      setDraft(nextDraft);
      setApplied(nextApplied);
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const url = useMemo(() => {
    if (!ready || !applied.from || !applied.to) return null;
    const parameters = new URLSearchParams(applied);
    return `/api/maintenance/ai-usage?${parameters}`;
  }, [applied, ready]);
  const resource = useApiData<UsageReport>(url, t("AI 用量读取失败"));

  function applyDates(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (resource.loading || !draft.from || !draft.to) return;
    setApplied(draft);
    const parameters = new URLSearchParams(draft);
    window.history.replaceState(null, "", `/ai-usage?${parameters}`);
  }

  function resetDates() {
    if (resource.loading) return;
    const next = currentUtcRange();
    setDraft(next);
    setApplied(next);
    window.history.replaceState(null, "", "/ai-usage");
  }

  async function refreshReport() {
    if (resource.loading || manualRefreshPending.current) return;
    manualRefreshPending.current = true;
    try {
      await resource.refresh();
    } finally {
      manualRefreshPending.current = false;
    }
  }

  if (!ready) return <LoadingState label={t("正在准备 AI 用量筛选器…")} />;
  const report = resource.data;
  return <>
    <PageHeading
      eyebrow="AI USAGE & RELIABILITY"
      title={t("AI 用量与可靠性")}
      description={t("按请求开始日（UTC）汇总当前付费 AI 的可信 Token 与 Credits 结算；显示的是已创建并完成预留的 inference cohort，不等同于全部调用尝试。")}
      actions={<button className="rc-button" type="button" disabled={resource.loading} onClick={() => void refreshReport()}>{t("刷新")}</button>}
    />
    <section className="rc-panel" aria-labelledby="ai-usage-filter-title">
      <header><div><small>REQUEST CREATED AT · UTC</small><h2 id="ai-usage-filter-title">{t("请求开始日期")}</h2><p>{t("最多 90 天；Token 与 Credits 按请求开始日归入 cohort。点击应用后直接读取，不需要二次确认。")}</p></div><StatusBadge value="UTC" /></header>
      <form className="rc-filter-grid" onSubmit={applyDates}>
        <label>{t("开始日期")}<input required type="date" value={draft.from} max={draft.to || undefined} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} /></label>
        <label>{t("结束日期")}<input required type="date" value={draft.to} min={draft.from || undefined} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} /></label>
        <div className="rc-action-row"><button className="rc-primary" type="submit" disabled={resource.loading || !draft.from || !draft.to}>{t("应用日期")}</button><button className="rc-button" type="button" disabled={resource.loading} onClick={resetDates}>{t("恢复默认 30 天")}</button></div>
      </form>
      {resource.loading && <p className="rc-live" aria-live="polite">{t("正在更新统计数据…")}</p>}
      {resource.error && <p className="rc-live" role="alert">{resource.error}</p>}
    </section>
    {!report && resource.loading ? <LoadingState label={t("正在读取 AI 用量与可靠性…")} /> : null}
    {!report && resource.error ? <ErrorState message={resource.error} retry={resource.refresh} /> : null}
    {!report && !resource.loading && !resource.error ? <ErrorState message={t("AI 用量响应为空")} retry={resource.refresh} /> : null}
    {report ? <>
    <section className="rc-kpi-grid" aria-label={t("AI 用量总览")}>
      <MetricCard label={t("请求总数")} value={report.summary.requestCount.toLocaleString(locale)} detail={`${report.summary.succeededCount} ${t("成功")} · ${report.summary.processingCount} ${t("处理中")}`} />
      <MetricCard label={t("总可信 Token")} value={addExactIntegers(report.summary.inputTokens, report.summary.outputTokens, locale, t("不可用"))} detail={`${t("输入")} ${exactInteger(report.summary.inputTokens, locale)} · ${t("输出")} ${exactInteger(report.summary.outputTokens, locale)}`} />
      <MetricCard label={t("已记录非取消失败率")} value={failureRate(report.summary.recordedFailureRate, t("无终态样本"))} detail={`${report.summary.recordedFailureCount} ${t("失败")} · ${report.summary.cancelledCount} ${t("主动取消")}`} />
      <MetricCard label={t("已结算 Credits")} value={exactInteger(report.summary.settledCredits, locale)} detail={`${report.summary.releasedCount} ${t("个请求已释放预留")}`} />
      <MetricCard label={t("固定费用规则")} value={t("待确认")} detail={`${report.pricing.blocker} · ${t("当前不可作为固定价验收")}`} />
      <MetricCard label={t("组织快照质量")} value={`${report.summary.organizationAttribution.capturedAtRequest} ${t("条原生快照")}`} detail={`${report.summary.organizationAttribution.legacyCurrentBackfill} ${t("迁移回填")} · ${report.summary.organizationAttribution.legacyUnattributed} ${t("历史未归属")}`} />
    </section>
    <UsageTable title={t("按日期")} eyebrow="DAILY · UTC" rows={report.byDay} label={(row) => row.key} />
    <UsageTable title={t("按功能")} eyebrow="FUNCTION" rows={report.byFunction} label={(row) => operationLabel(row.key, t)} />
    <UsageTable title={t("按 Agent")} eyebrow="AGENT ROLE" rows={report.byAgent} label={(row) => operationLabel(row.key, t)} />
    <ModelUsageTable groups={report.byModel} />
    <UsageTable title={t("按组织（请求级快照）")} eyebrow="ORGANIZATION" rows={report.byOrganization.data} label={(row) => row.label || row.key} truncated={report.byOrganization.truncated} showOrganizationQuality />
    <UsageTable title={t("按用户（脱敏标识）")} eyebrow="PSEUDONYMOUS USER" rows={report.byUser.data} label={(row) => row.key} truncated={report.byUser.truncated} />
    <section className="rc-panel" aria-label={t("统计口径说明")}>
      <header><div><small>METRIC CONTRACT</small><h2>{t("统计口径")}</h2></div></header>
      <p>{t("已记录非取消失败率 = 非取消失败 ÷（成功 + 非取消失败）。它只覆盖已建立 inference 且完成 Credits 预留的样本，不包含模型配置、余额不足等 preflight 拒绝；主动取消和处理中请求也不进入分母。此指标不能单独解释为 provider 或系统可用率。")}</p>
      <p>{t("Token 仅累加 provider 已验证的成功用量，Credits 仅累加已结算 reservation，并统一按请求开始日归入 UTC cohort；跨日完成或结算不会改变 cohort 日期。")}</p>
      <p className="rc-muted">{t("新请求固定发生时组织归属；迁移前历史仅能按迁移时归属回填并保留 legacy 标记，不能视为原始历史证据。")}</p>
    </section>
    </> : null}
  </>;
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><small>{label}</small><strong className="rc-kpi-status">{value}</strong><span>{detail}</span></article>;
}

function UsageTable({ title, eyebrow, rows, label, truncated = false, showOrganizationQuality = false }: {
  title: string;
  eyebrow: string;
  rows: UsageGroup[];
  label: (row: UsageGroup) => string;
  truncated?: boolean;
  showOrganizationQuality?: boolean;
}) {
  const { locale, t } = useAppLocale();
  return <section className="rc-panel">
    <header><div><small>{eyebrow}</small><h2>{title}</h2></div>{truncated && <StatusBadge value="Top 50" />}</header>
    {truncated && <p className="rc-muted">{t("当前展示请求数最高的 50 组；请缩小日期范围后继续核查。")}</p>}
    {!rows.length ? <p className="rc-muted">{t("所选日期没有可信 AI 请求。")}</p> : <div className="rc-table-wrap"><table>
      <thead><tr><th>{t("分组")}</th><th>{t("请求")}</th><th>{t("输入 / 输出 Token")}</th><th>{t("失败 / 取消")}</th><th>{t("已记录失败率")}</th><th>{t("已结算 Credits")}</th>{showOrganizationQuality && <th>{t("组织证据")}</th>}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}><td>{label(row)}</td><td>{row.requestCount.toLocaleString(locale)}<small>{row.succeededCount} {t("成功")} · {row.processingCount} {t("处理中")}</small></td><td>{exactInteger(row.inputTokens, locale)} / {exactInteger(row.outputTokens, locale)}</td><td>{row.recordedFailureCount} / {row.cancelledCount}</td><td>{failureRate(row.recordedFailureRate, t("无终态样本"))}</td><td>{exactInteger(row.settledCredits, locale)}<small>{row.releasedCount} {t("已释放")}</small></td>{showOrganizationQuality && <td>{row.organizationAttribution.capturedAtRequest} {t("原生")}<small>{row.organizationAttribution.legacyCurrentBackfill} {t("回填")} · {row.organizationAttribution.legacyUnattributed} {t("未归属")}</small></td>}</tr>)}</tbody>
    </table></div>}
  </section>;
}

function ModelUsageTable({ groups }: { groups: BoundedGroups<UsageModelGroup> }) {
  const { locale, t } = useAppLocale();
  return <section className="rc-panel">
    <header><div><small>PINNED MODEL REVISION</small><h2>{t("按模型版本")}</h2></div>{groups.truncated && <StatusBadge value="Top 50" />}</header>
    {groups.truncated && <p className="rc-muted">{t("当前展示请求数最高的 50 个固定模型版本。")}</p>}
    {!groups.data.length ? <p className="rc-muted">{t("所选日期没有可信模型用量。")}</p> : <div className="rc-table-wrap"><table>
      <thead><tr><th>{t("模型")}</th><th>{t("固定修订")}</th><th>{t("请求")}</th><th>{t("输入 / 输出 Token")}</th><th>{t("已记录失败率")}</th><th>{t("已结算 Credits")}</th></tr></thead>
      <tbody>{groups.data.map((row) => <tr key={row.key}><td>{row.modelName}<small>{row.providerName}</small></td><td><code>{row.key}</code></td><td>{row.requestCount.toLocaleString(locale)}</td><td>{exactInteger(row.inputTokens, locale)} / {exactInteger(row.outputTokens, locale)}</td><td>{failureRate(row.recordedFailureRate, t("无终态样本"))}</td><td>{exactInteger(row.settledCredits, locale)}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}
