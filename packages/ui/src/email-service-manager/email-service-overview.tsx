import { emailDeliveryErrorKind } from "@/packages/notifications/src/email-service-management";
import { StatusBadge } from "../page-state";
import { emailDeliveryErrorMessage, emailServiceStatusLabel } from "./presentation";
import type { EmailServiceManagerProps } from "./types";

type Props = Pick<EmailServiceManagerProps, "status" | "formatDateTime" | "translate">;

function errorText(code: string | null, t: (value: string) => string) {
  const error = emailDeliveryErrorKind(code);
  if (!error) return null;
  return `${t(emailDeliveryErrorMessage(error.kind))} ${error.code}`;
}

export function EmailServiceOverview({ status, formatDateTime, translate = value => value }: Props) {
  const t = translate;
  const latestError = errorText(status.lastTestErrorCode, t);
  return <>
    <section className="rc-kpi-grid" aria-label={t("邮件服务概况")}>
      <article><small>{t("综合状态")}</small><strong className="rc-kpi-status"><StatusBadge value={status.effectiveStatus} label={emailServiceStatusLabel(status.effectiveStatus)} /></strong><span>{status.effectiveStatus === "degraded" ? t("配置存在，但当前投递证据异常") : t("按配置、Worker 和投递证据综合判断")}</span></article>
      <article><small>{t("发信身份")}</small><strong>{status.senderAddress}</strong><span>{status.senderDomainVerified ? t("域名已验证") : t("域名未验证")}</span></article>
      <article><small>{t("Worker")}</small><strong className="rc-kpi-status"><StatusBadge value={status.workerEnabled ? "online" : "offline"} label={emailServiceStatusLabel(status.workerEnabled ? "online" : "offline")} /></strong><span>{formatDateTime(status.workerHeartbeatAt)}</span></article>
      <article><small>{t("最近测试")}</small><strong className="rc-kpi-status"><StatusBadge value={status.lastTestStatus ?? "not_tested"} label={emailServiceStatusLabel(status.lastTestStatus ?? "not_tested")} /></strong><span>{formatDateTime(status.lastTestAt)}</span></article>
    </section>
    {latestError ? <section className="rc-panel rc-error" role="alert"><header><div><small>DELIVERY ERROR</small><h2>{t("最近测试失败")}</h2></div><StatusBadge value={status.lastTestStatus} label={emailServiceStatusLabel(status.lastTestStatus)} /></header><p>{latestError}</p></section> : null}
    <section className="rc-panel"><header><div><small>DELIVERY GATES</small><h2>{t("外发检查项")}</h2></div></header>
      <dl className="rc-description-list">
        <div><dt>Resend API Key</dt><dd><StatusBadge value={status.apiKeyPresent ? "configured" : "missing"} label={emailServiceStatusLabel(status.apiKeyPresent ? "configured" : "missing")} /></dd></div>
        <div><dt>Webhook Secret</dt><dd><StatusBadge value={status.webhookSecretPresent ? "configured" : "missing"} label={emailServiceStatusLabel(status.webhookSecretPresent ? "configured" : "missing")} /></dd></div>
        <div><dt>{t("发信域名")}</dt><dd><StatusBadge value={status.senderDomainVerified ? "verified" : "unverified"} label={emailServiceStatusLabel(status.senderDomainVerified ? "verified" : "unverified")} /></dd></div>
        <div><dt>{t("模板")}</dt><dd><StatusBadge value={status.templatesReady ? "verified" : "incomplete"} label={emailServiceStatusLabel(status.templatesReady ? "verified" : "incomplete")} /></dd></div>
        <div><dt>{t("退信与投诉抑制")}</dt><dd><StatusBadge value={status.suppressionReady ? "enabled" : "incomplete"} label={emailServiceStatusLabel(status.suppressionReady ? "enabled" : "incomplete")} /></dd></div>
        <div><dt>{t("Provider 外发授权")}</dt><dd><StatusBadge value={status.providerAuthorized ? "active" : "disabled"} label={emailServiceStatusLabel(status.providerAuthorized ? "active" : "disabled")} /></dd></div>
      </dl>
    </section>
  </>;
}
