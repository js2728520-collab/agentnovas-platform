"use client";

import {
  formatDateTime,
  type MaintenanceTechnicalAuditEvent,
  type MaintenanceWorkerHealth,
  type MaintenanceWorkerStatus,
} from "@/packages/contracts/src/riverton-ui";
import { LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { readinessCopy, type ReadinessCheck } from "./readiness-presentation";

type PlatformHealth = { status: string; mode: string; timestamp: string };
type Readiness = { checks: ReadinessCheck[]; blockingCount: number; readyCount: number };

function workerEntries(data: MaintenanceWorkerHealth | null | undefined) {
  if (!data) return [] as Array<[string, MaintenanceWorkerStatus]>;
  return [
    ["Research Worker", data.researchWorker],
    ["Runtime Worker", data.runtimeWorker],
    ["Notification Worker", data.notificationWorker],
    ["Configuration Activation Worker", data.configurationActivationWorker],
    ["Payment Worker", data.paymentWorker],
    ["Demo Execution Worker", data.demoExecutionWorker],
  ] satisfies Array<[string, MaintenanceWorkerStatus]>;
}

function workerNeedsAttention(worker: MaintenanceWorkerStatus) {
  if (!worker.enabled) return false;
  const unresolvedFailure = Boolean(worker.lastFailureAt && (!worker.lastSuccessAt || worker.lastFailureAt > worker.lastSuccessAt));
  return unresolvedFailure || worker.health !== "healthy";
}

export function SystemOverviewWorkspace({ canViewAudit }: { canViewAudit: boolean }) {
  const { locale, t } = useAppLocale();
  const health = useApiData<PlatformHealth>("/api/health", t("平台健康读取失败"));
  const workers = useApiData<MaintenanceWorkerHealth>("/api/maintenance/payment-workers/health", t("运行状态读取失败"));
  const readiness = useApiData<Readiness>("/api/maintenance/readiness", t("就绪状态读取失败"));
  const audit = useApiData<{ data: MaintenanceTechnicalAuditEvent[] }>(canViewAudit ? "/api/maintenance/audit?status=failed&limit=5" : null, t("失败事件读取失败"));
  const resources = [health, workers, readiness, audit];
  const failures = resources.map((resource) => resource.error).filter(Boolean);
  const entries = workerEntries(workers.data);
  const failedWorkers = entries.filter(([, worker]) => workerNeedsAttention(worker));
  const criticalQueues = workers.data?.queues.filter((queue) => queue.status === "critical") ?? [];
  const blockingChecks = readiness.data?.checks.filter((check) => check.severity === "blocking" && check.status !== "ready") ?? [];
  const checkedAt = workers.data?.checkedAt || health.data?.timestamp || null;
  const loading = resources.some((resource) => resource.loading);
  const hasData = resources.some((resource) => resource.data);
  const sourceLabels = `${t("健康、Worker、队列、就绪检查")}${canViewAudit ? t("与技术审计") : ""}${t("接口")}`;

  function refresh() {
    for (const resource of resources) void resource.refresh();
  }

  return <>
    <PageHeading eyebrow="SYSTEM OPERATIONS" title={t("系统运行")} description={t("只展示可验证的健康、就绪、失败任务、安全事件和当前版本；配置存在不计为健康。")} actions={<button className="rc-button" type="button" onClick={refresh}>{t("重新检测")}</button>} />
    <p className="rc-dashboard-meta">{checkedAt ? <time dateTime={checkedAt}>{t("检测于")} {formatDateTime(checkedAt, locale)}</time> : <span>{t("等待首次检测")}</span>}<span>{t("数据来源：")}{sourceLabels}</span></p>
    {failures.length > 0 && <div className="rc-inline-error" role="alert">{t("部分检测不可用：")}{failures.join(locale === "zh-CN" ? "；" : "; ")}</div>}
    {loading && !hasData ? <LoadingState label={t("正在检查系统运行状态…")} /> : <section className="rc-kpi-grid" aria-label={t("系统运行关键状态")}>
      <article><small>{t("平台健康")}</small><strong className="rc-kpi-status">{t(health.data?.status ?? "未知")}</strong><span>{t("来源：实时健康探针")} · {health.data ? formatDateTime(health.data.timestamp, locale) : t("未返回")}</span></article>
      <article><small>{t("开服就绪")}</small><strong>{readiness.data?.blockingCount ?? "—"}</strong><span>{t("阻断项")} · {readiness.data ? `${readiness.data.readyCount}/${readiness.data.checks.length} ${t("已就绪")}` : t("状态待读取")}</span></article>
      <article><small>{t("数据库")}</small><strong className="rc-kpi-status">{t(workers.data?.database.status ?? "未知")}</strong><span>{t("来源：连接与迁移检查")} · {checkedAt ? formatDateTime(checkedAt, locale) : t("未检测")}</span></article>
      <article><small>{t("失败任务")}</small><strong>{workers.data ? failedWorkers.length : "—"}</strong><span>{workers.data ? `${criticalQueues.length} ${t("个严重队列")}` : t("状态待读取")}</span></article>
      <article><small>{t("当前版本")}</small><strong className="rc-kpi-status">{workers.data?.release.version ?? t("未报告")}</strong><span>{workers.data?.release.commitSha ? `commit ${workers.data.release.commitSha.slice(0, 12)}` : t("未报告 commit")}</span></article>
    </section>}
    <section className="rc-panel" aria-labelledby="system-attention-title">
      <header><div><small>{t("阻断与异常")}</small><h2 id="system-attention-title">{t("需要处理")}</h2></div><StatusBadge value={failedWorkers.length + criticalQueues.length + blockingChecks.length > 0 ? "attention" : "ready"} /></header>
      <div className="rc-health-grid">
        {blockingChecks.map((check) => {
          const copy = readinessCopy(check, locale);
          return <article key={check.key}><span>{copy.label}</span><StatusBadge value={check.status} /><small>{copy.detail}</small></article>;
        })}
        {failedWorkers.map(([label, worker]) => <article key={label}><span>{t(label)}</span><StatusBadge value={worker.health} /><small>{worker.lastErrorCode ? `${t("最近错误")} ${worker.lastErrorCode}` : t("运行状态需要检查")}{worker.lastFailureAt ? ` · ${formatDateTime(worker.lastFailureAt, locale)}` : ""}</small></article>)}
        {criticalQueues.map((queue) => <article key={queue.queue}><span>{queue.queue}</span><StatusBadge value={queue.status} /><small>{queue.depth} {t("项 · 最老")} {queue.oldestAgeSeconds ?? "—"} {t("秒")}</small></article>)}
        {readiness.data && workers.data && blockingChecks.length === 0 && failedWorkers.length === 0 && criticalQueues.length === 0 && <article><span>{t("当前无运行阻断")}</span><StatusBadge value="ready" /><small>{t("结论来自本次就绪、Worker 与队列检测。")}</small></article>}
      </div>
    </section>
    {canViewAudit && <section className="rc-panel" aria-labelledby="system-failure-events-title">
      <header><div><small>{t("最近 5 条")}</small><h2 id="system-failure-events-title">{t("安全与技术失败事件")}</h2></div></header>
      {!audit.data?.data.length ? <p className="rc-muted-copy">{t("本次查询没有失败事件。")}</p> : <div className="rc-health-grid">{audit.data.data.map((event) => <article key={event.id}><span>{event.domain} · {event.action}</span><StatusBadge value={event.status} /><small>{formatDateTime(event.createdAt, locale)}{event.errorCode ? ` · ${event.errorCode}` : ""}</small></article>)}</div>}
    </section>}
  </>;
}
