"use client";

import {
  formatDateTime,
  maintenanceQueueDisplayStatus,
  maintenanceResourceDisplayStatus,
  maintenanceResourcePhase,
  type MaintenanceEmailStatus,
  type MaintenancePaymentProvider,
  type MaintenanceResourcePhase,
  type MaintenanceWorkerHealth,
  type MaintenanceWorkerStatus,
} from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type PlatformHealth = { status: string; mode: string; timestamp: string };

export function SystemHealthWorkspace() {
  const { locale, t } = useAppLocale();
  const health = useApiData<PlatformHealth>("/api/health", t("平台健康读取失败"));
  const workers = useApiData<MaintenanceWorkerHealth>("/api/maintenance/payment-workers/health", t("Worker 状态读取失败"));
  const email = useApiData<MaintenanceEmailStatus>("/api/maintenance/email/status", t("邮件状态读取失败"));
  const payments = useApiData<{ providers: MaintenancePaymentProvider[] }>("/api/maintenance/payment-providers", t("支付状态读取失败"));
  const healthPhase = maintenanceResourcePhase(health);
  const workersPhase = maintenanceResourcePhase(workers);
  const emailPhase = maintenanceResourcePhase(email);
  const paymentsPhase = maintenanceResourcePhase(payments);
  const healthData = healthPhase === "ready" ? health.data : null;
  const workersData = workersPhase === "ready" ? workers.data : null;
  const emailData = emailPhase === "ready" ? email.data : null;
  const paymentsData = paymentsPhase === "ready" ? payments.data : null;
  const queueStatus = maintenanceQueueDisplayStatus(workersPhase, workersData?.queues);
  const queuePhase = workersPhase === "ready" && !workersData?.queues.length ? "unknown" : workersPhase;
  return <>
    <PageHeading eyebrow="SYSTEM CONTROL" title={t("系统健康")} description={t("配置、启用、存活、健康和陈旧状态分别展示；单项检测失败不会被包装成正常。")} actions={<button className="rc-button" type="button" onClick={() => { void health.refresh(); void workers.refresh(); void email.refresh(); void payments.refresh(); }}>{t("重新检测全部")}</button>} />
    <section className="rc-panel" aria-labelledby="health-resource-status-title">
      <header><div><small>RESOURCE AVAILABILITY</small><h2 id="health-resource-status-title">{t("检测来源状态")}</h2></div></header>
      <div className="rc-health-grid">
        <ResourceAvailability label={t("平台健康")} phase={healthPhase} error={health.error} retry={health.refresh} />
        <ResourceAvailability label={t("Worker、队列与数据库")} phase={workersPhase} error={workers.error} retry={workers.refresh} />
        <ResourceAvailability label={t("邮件集成")} phase={emailPhase} error={email.error} retry={email.refresh} />
        <ResourceAvailability label={t("支付配置")} phase={paymentsPhase} error={payments.error} retry={payments.refresh} />
      </div>
    </section>
    <section className="rc-kpi-grid">
      <HealthCard label={t("数据库")} value={workersData?.database.status ?? resourceDisplayLabel(workersPhase, t)} detail={workersData ? `${t("检测于")} ${formatDateTime(workersData.checkedAt, locale)}` : resourceDetail(workersPhase, workers.error, t)} />
      <HealthCard label="Payment Worker" value={workersData?.paymentWorker.enabled ? t("配置违例") : workersData?.paymentWorker.health ?? resourceDisplayLabel(workersPhase, t)} detail={workerDetail(workersData?.paymentWorker, workersPhase, workers.error, t, locale)} />
      <HealthCard label="Notification Worker" value={workersData?.notificationWorker.health ?? resourceDisplayLabel(workersPhase, t)} detail={workerDetail(workersData?.notificationWorker, workersPhase, workers.error, t, locale)} />
      <HealthCard label="Configuration Activation Worker" value={workersData?.configurationActivationWorker.health ?? resourceDisplayLabel(workersPhase, t)} detail={workerDetail(workersData?.configurationActivationWorker, workersPhase, workers.error, t, locale)} />
      <HealthCard label={t("永续真实订单")} value={t("始终禁用")} detail={healthData?.mode ?? resourceDisplayLabel(healthPhase, t)} />
    </section>
    <section className="rc-panel"><header><div><small>{t("核心检查")}</small><h2>{t("Worker 真实运行状态")}</h2></div><StatusBadge value={healthData?.status ?? maintenanceResourceDisplayStatus(healthPhase)} /></header><div className="rc-health-grid">
      <WorkerState label="Research Worker" value={workersData?.researchWorker} resourcePhase={workersPhase} resourceError={workers.error} />
      <WorkerState label="Runtime Worker" value={workersData?.runtimeWorker} resourcePhase={workersPhase} resourceError={workers.error} />
      <WorkerState label="Notification Worker" value={workersData?.notificationWorker} resourcePhase={workersPhase} resourceError={workers.error} />
      <WorkerState label="Configuration Activation Worker" value={workersData?.configurationActivationWorker} resourcePhase={workersPhase} resourceError={workers.error} />
      <WorkerState label={t("Payment Worker（Beta 必须 disabled）")} value={workersData?.paymentWorker} resourcePhase={workersPhase} resourceError={workers.error} />
      <WorkerState label="Demo Execution Worker" value={workersData?.demoExecutionWorker} resourcePhase={workersPhase} resourceError={workers.error} externalWritesEnabled={workersData?.demoExecutionWorker.externalWritesEnabled} executionEnabled={workersData?.demoExecutionWorker.executionEnabled} />
    </div></section>
    <section className="rc-panel"><header><div><small>{t("外部服务")}</small><h2>{t("集成配置概况")}</h2></div></header><div className="rc-health-grid"><article><span>{t("邮件服务")}</span><StatusBadge value={emailData ? emailData.configured ? "configured" : "unconfigured" : maintenanceResourceDisplayStatus(emailPhase)} /><small>{emailData ? `enabled ${emailData.workerEnabled ? "yes" : "no"} · send authorized ${emailData.sendAuthorized ? "yes" : "no"}` : resourceDetail(emailPhase, email.error, t)}</small></article><article><span>{t("优盾有效充值网络")}</span><b>{paymentsData ? paymentsData.providers.filter((provider) => provider.effectiveStatus === "active").length : resourceDisplayLabel(paymentsPhase, t)}</b><small>{paymentsData ? t("仅 deposit-only；入账仍需双人复核") : resourceDetail(paymentsPhase, payments.error, t)}</small></article><article><span>{t("含密钥支付配置")}</span><b>{paymentsData ? paymentsData.providers.filter((provider) => provider.hasSecret).length : resourceDisplayLabel(paymentsPhase, t)}</b><small>{paymentsData ? t("仅显示存在状态，不回显密钥") : resourceDetail(paymentsPhase, payments.error, t)}</small></article></div></section>
    <section className="rc-panel"><header><div><small>QUEUE &amp; DATABASE</small><h2>{t("积压、阈值与迁移")}</h2></div><StatusBadge value={queueStatus} /></header>{queuePhase === "ready" ? <div className="rc-health-grid">{workersData?.queues.map((queue) => <article key={queue.queue}><span>{queue.queue}</span><StatusBadge value={queue.status} /><b>{queue.depth} {t("项")}</b><small>{t("最老：")}{queue.oldestAgeSeconds === null ? "—" : `${queue.oldestAgeSeconds}s`} · {t("告警")} {queue.warningAgeSeconds}s / {queue.criticalAgeSeconds}s</small></article>)}</div> : <ResourceAvailability label={t("队列指标")} phase={queuePhase} error={workers.error} retry={workers.refresh} />}
      <dl className="rc-description-list"><div><dt>DB pool</dt><dd>{workersData ? `${workersData.database.pool.total} total / ${workersData.database.pool.idle} idle / ${workersData.database.pool.waiting} waiting` : resourceDisplayLabel(workersPhase, t)}</dd></div><div><dt>{t("最新迁移")}</dt><dd>{workersData ? workersData.database.migration?.latest ?? t("未记录") : resourceDisplayLabel(workersPhase, t)}</dd></div><div><dt>checksum / commit</dt><dd>{workersData ? workersData.database.migration ? `${workersData.database.migration.checksumRecorded ? "yes" : "no"} / ${workersData.database.migration.commitRecorded ? "yes" : "no"}` : t("未记录") : resourceDisplayLabel(workersPhase, t)}</dd></div></dl></section>
  </>;
}

function HealthCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><small>{label}</small><strong className="rc-kpi-status">{value}</strong><span>{detail}</span></article>;
}

function resourceDisplayLabel(phase: MaintenanceResourcePhase, t: (value: string) => string) {
  return phase === "loading" ? t("检测中") : phase === "error" ? t("不可用") : phase === "unknown" ? t("未知") : t("可用");
}

function resourceDetail(phase: MaintenanceResourcePhase, error: string | undefined, t: (value: string) => string) {
  if (phase === "loading") return t("正在读取实时状态");
  if (phase === "error") return error || t("检测接口不可用");
  if (phase === "unknown") return t("尚无可验证的检测结果");
  return t("检测接口可用");
}

function workerDetail(worker: MaintenanceWorkerStatus | undefined, phase: MaintenanceResourcePhase, error: string | undefined, t: (value: string) => string, locale: string) {
  if (!worker) return resourceDetail(phase === "ready" ? "unknown" : phase, error, t);
  if (!worker.configured) return t("运行依赖未配置");
  if (!worker.enabled) return t("开关已关闭");
  return worker.heartbeatAt ? `${t("最近心跳")} ${formatDateTime(worker.heartbeatAt, locale)}` : t("尚未收到进程心跳");
}

function ResourceAvailability({ label, phase, error, retry }: {
  label: string;
  phase: MaintenanceResourcePhase;
  error?: string;
  retry: () => Promise<void>;
}) {
  const { t } = useAppLocale();
  return <article className="rc-worker-state" aria-busy={phase === "loading"}>
    <span>{label}</span>
    <StatusBadge value={maintenanceResourceDisplayStatus(phase)} />
    <small role={phase === "error" ? "alert" : undefined}>{resourceDetail(phase, error, t)}</small>
    {(phase === "error" || phase === "unknown") && <button className="rc-button" type="button" onClick={() => void retry()}>{t("重新读取")} {label}</button>}
  </article>;
}

function WorkerState({ label, value, resourcePhase, resourceError, externalWritesEnabled, executionEnabled }: {
  label: string;
  value?: MaintenanceWorkerStatus;
  resourcePhase: MaintenanceResourcePhase;
  resourceError?: string;
  externalWritesEnabled?: boolean;
  executionEnabled?: boolean;
}) {
  const { locale, t } = useAppLocale();
  const effectivePhase = value ? "ready" : resourcePhase === "ready" ? "unknown" : resourcePhase;
  const unavailableValue = resourceDisplayLabel(effectivePhase, t);
  return <article className="rc-worker-state">
    <span>{label}</span>
    <StatusBadge value={value?.health ?? maintenanceResourceDisplayStatus(effectivePhase)} />
    <dl className="rc-description-list">
      <div><dt>configured</dt><dd>{value ? value.configured ? "yes" : "no" : unavailableValue}</dd></div>
      <div><dt>enabled</dt><dd>{value ? value.enabled ? "yes" : "no" : unavailableValue}</dd></div>
      <div><dt>alive / stale</dt><dd>{value?.liveness ?? unavailableValue}</dd></div>
      <div><dt>healthy / stale</dt><dd>{value?.health ?? unavailableValue}</dd></div>
      {typeof externalWritesEnabled === "boolean" && <div><dt>externalWritesEnabled</dt><dd>{externalWritesEnabled ? "yes" : "no"}</dd></div>}
      {typeof executionEnabled === "boolean" && <div><dt>executionEnabled</dt><dd>{executionEnabled ? "yes" : "no"}</dd></div>}
    </dl>
    <small>{workerDetail(value, effectivePhase, resourceError, t, locale)}</small>
    {value?.lastErrorCode && <small>{t("最近错误：")}{value.lastErrorCode} · {formatDateTime(value.lastFailureAt, locale)}</small>}
    {value?.lastSuccessAt && <small>{t("最近成功：")}{formatDateTime(value.lastSuccessAt, locale)}</small>}
    {value?.currentJobId && <small>{t("当前任务：")}{value.currentJobId}</small>}
    {value?.commitSha && <small>{t("版本：")}{value.commitSha.slice(0, 12)}</small>}
  </article>;
}
