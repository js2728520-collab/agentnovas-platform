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
    <PageHeading eyebrow="EMAIL INTEGRATION" title="邮件服务" description="配置、授权、外发和送达状态分别展示；API Key、Webhook Secret 和收件人名单不会回显。" actions={canManage ? <button className="rc-button" type="button" disabled={testing} onClick={() => setDialogOpen(true)}>{testing ? "检测中…" : "执行安全测试"}</button> : undefined} />
    <section className="rc-kpi-grid"><article><small>有效状态</small><strong className="rc-kpi-status"><StatusBadge value={status?.effectiveStatus ?? "configured_not_sent"} /></strong><span>{status?.effectiveStatus === "ready" ? "已满足受控外发 Gate" : "已配置但未发送"}</span></article><article><small>配置状态</small><strong className="rc-kpi-status"><StatusBadge value={status?.configured ? "configured" : "unconfigured"} /></strong><span>{status?.apiKeyPresent ? "API Key 存在" : "API Key 未配置"}</span></article><article><small>发信域名</small><strong className="rc-kpi-status"><StatusBadge value={status?.senderDomainVerified ? "verified" : "unverified"} /></strong><span>{status?.senderDomain || "未提供"}</span></article><article><small>最近测试</small><strong className="rc-kpi-status">{formatDateTime(status?.lastTestAt)}</strong><span>未测试不会显示成功</span></article></section>
    <section className="rc-panel"><header><div><small>PRODUCTION GATES</small><h2>受控外发检查项</h2></div></header><dl className="rc-description-list"><div><dt>Webhook Secret</dt><dd>{status?.webhookSecretPresent ? "存在（不可回显）" : "未配置"}</dd></div><div><dt>收件人 allowlist</dt><dd>{status?.allowlistPresent ? "已配置（不可回显）" : "未配置"}</dd></div><div><dt>模板验证</dt><dd>{status?.templatesReady ? "已验证" : "未验证"}</dd></div><div><dt>退信/投诉 suppression</dt><dd>{status?.suppressionReady ? "已启用" : "未就绪"}</dd></div><div><dt>Worker</dt><dd>{status?.workerEnabled ? "已启用" : "未启用"}</dd></div><div><dt>外发授权</dt><dd>{status?.sendAuthorized ? "已授权" : "未授权"}</dd></div></dl><p className="rc-muted">任一检查项未通过时系统不会外发。退信、投诉或 provider suppression 会按收件人哈希阻止后续发送。</p><div className="rc-live" aria-live="polite">{message}</div></section>
    <ConfirmActionDialog open={dialogOpen} title="执行邮件配置测试" description="当前测试只验证配置并记录时间，不会发送真实邮件。" confirmLabel="确认并测试" busy={testing} onCancel={() => setDialogOpen(false)} onConfirm={(reason) => void test(reason)} />
  </>;
}
