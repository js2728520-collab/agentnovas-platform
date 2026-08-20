"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime, type MaintenancePaymentProvider } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

export function PaymentIntegrationWorkspace({ canManage }: { canManage: boolean }) {
  const resource = useApiData<{ providers: MaintenancePaymentProvider[] }>("/api/maintenance/payment-providers", "支付配置读取失败");
  const [pending, setPending] = useState<{ kind: "status"; provider: MaintenancePaymentProvider; status: string } | { kind: "test"; provider: MaintenancePaymentProvider } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function execute(reason: string) {
    if (!pending) return;
    setBusy(true); setMessage("");
    try {
      const response = pending.kind === "test"
        ? await fetch(`/api/maintenance/payment-providers/${encodeURIComponent(pending.provider.id)}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) })
        : await fetch(`/api/maintenance/payment-providers/${encodeURIComponent(pending.provider.id)}/status`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: pending.status, reason }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "支付配置更新失败"));
      setMessage(pending.kind === "test"
        ? payload.status === "configured_not_called" ? "已配置但未调用服务商：连通测试尚未实际执行。" : "测试已返回，结果以服务端回执为准。"
        : `支付渠道状态已记录为 ${pending.status}。此操作没有执行真实支付。`);
      setPending(null); await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "支付配置更新失败"); }
    finally { setBusy(false); }
  }
  if (resource.loading && !resource.data) return <LoadingState label="正在读取支付配置…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  return <>
    <PageHeading eyebrow="PAYMENT INTEGRATION" title="支付服务" description="只展示渠道、网络、阈值和密钥存在状态，不显示密钥、端点或 Webhook 内容。" />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel"><header><div><small>{resource.data?.providers.length ?? 0} 个配置</small><h2>支付渠道</h2></div></header>{!resource.data?.providers.length ? <EmptyState title="未配置支付服务" description="客户端创建充值时会收到明确的 503 原因，不会生成地址或二维码。" /> : <div className="rc-card-list">{resource.data.providers.map((provider) => <article key={provider.id}><header><div><b>{provider.provider}</b><small>{provider.channel} · {provider.network || "无网络"}</small></div><StatusBadge value={provider.status} /></header><dl className="rc-description-list"><div><dt>确认阈值</dt><dd>{provider.confirmationThreshold ?? "未设置"}</dd></div><div><dt>密钥</dt><dd>{provider.hasSecret ? "已保存（不可回显）" : "未配置"}</dd></div><div><dt>更新时间</dt><dd>{formatDateTime(provider.updatedAt)}</dd></div></dl>{canManage && <div className="rc-action-row rc-card-actions"><button className="rc-button" type="button" onClick={() => setPending({ kind: "test", provider })}>连通测试</button>{["sandbox", "active", "disabled"].filter((status) => status !== provider.status).map((status) => <button className="rc-button" type="button" key={status} onClick={() => setPending({ kind: "status", provider, status })}>切换 {status}</button>)}</div>}</article>)}</div>}</section>
    <ConfirmActionDialog open={Boolean(pending)} title={pending?.kind === "test" ? "执行支付配置测试" : `切换为 ${pending?.status ?? ""}`} description={pending?.kind === "test" ? "当前测试只验证服务端测试开关和安全配置，不会调用服务商或执行支付。" : "状态切换会影响客户端可用渠道，但不会发起真实支付。请记录变更依据。"} confirmLabel={pending?.kind === "test" ? "确认并测试" : "确认切换"} busy={busy} onCancel={() => setPending(null)} onConfirm={(reason) => void execute(reason)} />
  </>;
}
