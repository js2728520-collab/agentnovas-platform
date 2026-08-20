"use client";

import { formatDateTime, type MaintenanceEmailStatus, type MaintenancePaymentProvider } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type PlatformHealth = { status: string; mode: string; timestamp: string };
type WorkerStatus = {
  configured: boolean;
  enabled: boolean;
  liveness: "missing" | "alive" | "stale";
  health: "disabled" | "unconfigured" | "missing" | "stale" | "degraded" | "healthy";
  runtimeStatus: string | null;
  heartbeatAt: string | null;
};
type WorkerHealth = {
  checkedAt: string;
  database: { status: string };
  paymentWorker: WorkerStatus;
  notificationWorker: WorkerStatus & { resendConfigured: boolean };
  researchWorker: WorkerStatus;
  runtimeWorker: WorkerStatus;
  demoExecutionWorker: WorkerStatus;
};

export function SystemHealthWorkspace({ overview = false }: { overview?: boolean }) {
  const health = useApiData<PlatformHealth>("/api/health", "平台健康读取失败");
  const workers = useApiData<WorkerHealth>("/api/maintenance/payment-workers/health", "Worker 状态读取失败");
  const email = useApiData<MaintenanceEmailStatus>("/api/maintenance/email/status", "邮件状态读取失败");
  const payments = useApiData<{ providers: MaintenancePaymentProvider[] }>("/api/maintenance/payment-providers", "支付状态读取失败");
  const loading = health.loading || workers.loading || email.loading || payments.loading;
  const error = health.error || workers.error || email.error || payments.error;
  if (loading && !health.data && !workers.data) return <LoadingState label="正在检查系统状态…" />;
  return <>
    <PageHeading eyebrow="SYSTEM CONTROL" title={overview ? "系统概览" : "系统健康"} description="配置存在、Worker 开关和运行状态分别展示，不把已配置描述为正在运行。" actions={<button className="rc-button" type="button" onClick={() => { void health.refresh(); void workers.refresh(); void email.refresh(); void payments.refresh(); }}>重新检测</button>} />
    {error && <div className="rc-inline-error" role="alert">部分检测不可用：{error}</div>}
    <section className="rc-kpi-grid">
      <HealthCard label="数据库" value={workers.data?.database.status ?? "未知"} detail={workers.data ? `检测于 ${formatDateTime(workers.data.checkedAt)}` : "未检测"} />
      <HealthCard label="Payment Worker" value={workers.data?.paymentWorker.health ?? "未知"} detail={workerDetail(workers.data?.paymentWorker)} />
      <HealthCard label="Notification Worker" value={workers.data?.notificationWorker.health ?? "未知"} detail={workerDetail(workers.data?.notificationWorker)} />
      <HealthCard label="永续真实订单" value="始终禁用" detail={health.data?.mode || "shadow-paper-only"} />
    </section>
    <section className="rc-panel"><header><div><small>核心检查</small><h2>Worker 真实运行状态</h2></div><StatusBadge value={health.data?.status || "unknown"} /></header><div className="rc-health-grid">
      <WorkerState label="Research Worker" value={workers.data?.researchWorker} />
      <WorkerState label="Runtime Worker" value={workers.data?.runtimeWorker} />
      <WorkerState label="Demo Execution Worker" value={workers.data?.demoExecutionWorker} />
    </div></section>
    <section className="rc-panel"><header><div><small>外部服务</small><h2>集成配置概况</h2></div></header><div className="rc-health-grid"><article><span>邮件服务</span><StatusBadge value={email.data?.configured ? "configured" : "unconfigured"} /></article><article><span>已配置支付渠道</span><b>{payments.data?.providers.filter((provider) => provider.status !== "disabled").length ?? "—"}</b></article><article><span>含密钥支付配置</span><b>{payments.data?.providers.filter((provider) => provider.hasSecret).length ?? "—"}</b></article></div></section>
    {!health.data && !workers.data && error && <ErrorState message={error} retry={() => { void health.refresh(); void workers.refresh(); }} />}
  </>;
}

function HealthCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><small>{label}</small><strong className="rc-kpi-status">{value}</strong><span>{detail}</span></article>;
}

function workerDetail(worker?: WorkerStatus) {
  if (!worker) return "未检测";
  if (!worker.configured) return "运行依赖未配置";
  if (!worker.enabled) return "开关已关闭";
  return worker.heartbeatAt ? `最近心跳 ${formatDateTime(worker.heartbeatAt)}` : "尚未收到进程心跳";
}

function WorkerState({ label, value }: { label: string; value?: WorkerStatus }) {
  return <article><span>{label}</span><StatusBadge value={value?.health ?? "unknown"} /><small>{workerDetail(value)}</small></article>;
}
