"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime, type MaintenanceEmailStatus } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function EmailIntegrationWorkspace({ canManage }: { canManage: boolean }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<MaintenanceEmailStatus & { senderAddress?: string; senderDomain?: string }>("/api/maintenance/email/status", t("邮件状态读取失败"));
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  async function test() {
    setTesting(true); setMessage("");
    try {
      const response = await fetch("/api/maintenance/email/test", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, t("邮件测试失败")));
      setMessage(payload.status === "queued" ? t("测试邮件已入队；请等待 Worker 发送和 Webhook 更新送达状态。") : apiErrorMessage(payload, t("测试状态未知")));
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("邮件测试失败")); }
    finally { setTesting(false); }
  }
  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取邮件配置…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const status = resource.data;
  return <>
    <PageHeading eyebrow="EMAIL INTEGRATION" title={t("邮件服务")} description={t("配置、授权、外发和送达状态分别展示；API Key、Webhook Secret 和收件人名单不会回显。")} />
    <section className="rc-kpi-grid"><article><small>{t("有效状态")}</small><strong className="rc-kpi-status"><StatusBadge value={status?.effectiveStatus ?? "configured_not_sent"} /></strong><span>{status?.effectiveStatus === "ready" ? t("已满足受控外发 Gate") : t("已配置但未发送")}</span></article><article><small>{t("配置状态")}</small><strong className="rc-kpi-status"><StatusBadge value={status?.configured ? "configured" : "unconfigured"} /></strong><span>{status?.apiKeyPresent ? t("API Key 存在") : t("API Key 未配置")}</span></article><article><small>{t("发信域名")}</small><strong className="rc-kpi-status"><StatusBadge value={status?.senderDomainVerified ? "verified" : "unverified"} /></strong><span>{status?.senderDomain || t("未提供")}</span></article><article><small>{t("最近测试请求")}</small><strong className="rc-kpi-status">{formatDateTime(status?.lastTestAt, locale)}</strong><span>{status?.lastTestStatus ? `${t("投递状态：")}${status.lastTestStatus}` : t("尚未提交测试")}</span></article></section>
    <section className="rc-panel"><header><div><small>PRODUCTION GATES</small><h2>{t("受控外发检查项")}</h2></div></header><dl className="rc-description-list"><div><dt>Webhook Secret</dt><dd>{status?.webhookSecretPresent ? t("存在（不可回显）") : t("未配置")}</dd></div><div><dt>{t("收件人 allowlist")}</dt><dd>{status?.allowlistPresent ? t("已配置（不可回显）") : t("未配置")}</dd></div><div><dt>{t("模板验证")}</dt><dd>{status?.templatesReady ? t("已验证") : t("未验证")}</dd></div><div><dt>{t("退信/投诉 suppression")}</dt><dd>{status?.suppressionReady ? t("已启用") : t("未就绪")}</dd></div><div><dt>{t("Worker 心跳")}</dt><dd>{status?.workerEnabled ? `${t("正常")} · ${formatDateTime(status.workerHeartbeatAt, locale)}` : t("未连接或已过期")}</dd></div><div><dt>{t("外发授权")}</dt><dd>{status?.sendAuthorized ? t("已授权") : t("未授权")}</dd></div></dl><p className="rc-muted">{t("任一检查项未通过时系统不会外发。退信、投诉或 provider suppression 会按收件人哈希阻止后续发送。")}</p>{canManage ? <div className="rc-action-row"><button className="rc-primary" type="button" disabled={testing} onClick={() => void test()}>{testing ? t("正在入队…") : t("发送测试邮件")}</button></div> : null}<div className="rc-live" aria-live="polite">{message}</div></section>
    <section className="rc-panel"><header><div><small>MAIL IDENTITIES</small><h2>{t("邮件身份")}</h2></div></header><dl className="rc-description-list"><div><dt>{t("事务通知发件人")}</dt><dd>{status?.senderAddress || "noreply@agentnovas.com"}</dd></div><div><dt>{t("客户支持")}</dt><dd>{status?.contactAddresses.support || "support@agentnovas.com"}</dd></div><div><dt>{t("账户安全")}</dt><dd>{status?.contactAddresses.security || "security@agentnovas.com"}</dd></div><div><dt>{t("账务咨询")}</dt><dd>{status?.contactAddresses.billing || "billing@agentnovas.com"}</dd></div><div><dt>{t("运营协作")}</dt><dd>{status?.contactAddresses.operations || "operations@agentnovas.com"}</dd></div></dl><p className="rc-muted">{status?.inboundMailboxesVerified ? t("收件邮箱已完成独立验证。") : t("后四个地址当前仅为保留身份；在企业邮箱 MX 和真实收件测试通过前，客户端不会把它们宣称为可用客服渠道。")}</p></section>
  </>;
}
