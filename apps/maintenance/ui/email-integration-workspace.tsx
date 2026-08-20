"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime, type MaintenanceEmailStatus } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

export function EmailIntegrationWorkspace({ canManage }: { canManage: boolean }) {
  const resource = useApiData<MaintenanceEmailStatus & { senderAddress?: string; senderDomain?: string }>("/api/maintenance/email/status", "邮件状态读取失败");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  async function test(reason: string) {
    setTesting(true); setMessage("");
    try {
      const response = await fetch("/api/maintenance/email/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "邮件测试失败"));
      setMessage(payload.status === "configured_not_sent" ? "已配置但未发送：测试邮件能力尚未启用。" : apiErrorMessage(payload, "测试状态未知"));
      setDialogOpen(false);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "邮件测试失败"); }
    finally { setTesting(false); }
  }
  if (resource.loading && !resource.data) return <LoadingState label="正在读取邮件配置…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const status = resource.data;
  return <>
    <PageHeading eyebrow="EMAIL INTEGRATION" title="邮件服务" description="仅展示配置、域名验证和测试状态；API Key 不会回显。" actions={canManage ? <button className="rc-button" type="button" disabled={testing} onClick={() => setDialogOpen(true)}>{testing ? "检测中…" : "执行安全测试"}</button> : undefined} />
    <section className="rc-kpi-grid"><article><small>服务商</small><strong className="rc-kpi-status">Resend</strong><span>固定邮件通道</span></article><article><small>配置状态</small><strong className="rc-kpi-status"><StatusBadge value={status?.configured ? "configured" : "unconfigured"} /></strong><span>{status?.apiKeyPresent ? "API Key 存在" : "API Key 未配置"}</span></article><article><small>发信域名</small><strong className="rc-kpi-status"><StatusBadge value={status?.senderDomainVerified ? "verified" : "unverified"} /></strong><span>{status?.senderDomain || "未提供"}</span></article><article><small>最近测试</small><strong className="rc-kpi-status">{formatDateTime(status?.lastTestAt)}</strong><span>未测试不会显示成功</span></article></section>
    <section className="rc-panel"><header><div><small>安全状态</small><h2>邮件发送能力</h2></div></header><p className="rc-muted">配置存在不等于邮件已发送。当前测试接口返回 configured_not_sent 时，页面只会显示“已配置但未发送”。</p><div className="rc-live" aria-live="polite">{message}</div></section>
    <ConfirmActionDialog open={dialogOpen} title="执行邮件配置测试" description="当前测试只验证配置并记录时间，不会发送真实邮件。" confirmLabel="确认并测试" busy={testing} onCancel={() => setDialogOpen(false)} onConfirm={(reason) => void test(reason)} />
  </>;
}
