"use client";

import { useState } from "react";

import { EmptyState, StatusBadge } from "../page-state";
import { emailServiceStatusLabel } from "./presentation";
import type { EmailServiceManagerProps } from "./types";

type Props = EmailServiceManagerProps;

export function EmailServiceConfiguration(props: Props) {
  const { status,recipients,canManage,busy,translate = value=>value,formatDateTime }=props;
  const t=translate;
  const [apiKey,setApiKey]=useState("");
  const [webhookSecret,setWebhookSecret]=useState("");
  const [email,setEmail]=useState("");
  const [label,setLabel]=useState("");
  const [verificationCodes,setVerificationCodes]=useState<Record<string,string>>({});
  const secretOperation=status.apiKeyPresent && status.webhookSecretPresent ? "rotate" : "install";
  const broker=status.secretManagement?.broker;
  const latest=status.secretManagement?.latestRequest;
  const secretRequestActive=latest?.status==="pending" || latest?.status==="applying";
  const validSecrets=/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey) && /^whsec_[A-Za-z0-9_-]{8,}$/.test(webhookSecret);

  async function submitSecrets() {
    if (!await props.onSecretChange({ operation: secretOperation,apiKey,webhookSecret })) return;
    setApiKey("");setWebhookSecret("");
  }

  async function createRecipient() {
    if (!await props.onRecipientCreate({ email: email.trim(),label: label.trim() })) return;
    setEmail("");setLabel("");
  }

  return <>
    <section className="rc-panel"><header><div><small>PROVIDER & SECRET BROKER</small><h2>{t("Provider 与密钥")}</h2><p>{t("浏览器使用 Broker 公钥加密；Web、数据库和审计只接触密文，密钥不会回显。")}</p></div><StatusBadge value={status.secretManagement?.browserConfigurable ? "ready" : "unconfigured"} label={emailServiceStatusLabel(status.secretManagement?.browserConfigurable ? "ready" : "unconfigured")} /></header>
      <dl className="rc-description-list rc-email-provider-facts">
        <div><dt>{t("服务商")}</dt><dd>Resend</dd></div>
        <div><dt>{t("发信地址")}</dt><dd>{status.senderAddress}</dd></div>
        <div><dt>Webhook URL</dt><dd><code>{status.webhookUrl}</code></dd></div>
        <div><dt>API Key</dt><dd><StatusBadge value={status.apiKeyPresent ? "configured" : "missing"} label={emailServiceStatusLabel(status.apiKeyPresent ? "configured" : "missing")} /></dd></div>
        <div><dt>Webhook Secret</dt><dd><StatusBadge value={status.webhookSecretPresent ? "configured" : "missing"} label={emailServiceStatusLabel(status.webhookSecretPresent ? "configured" : "missing")} /></dd></div>
        <div><dt>Secret Broker</dt><dd><StatusBadge value={broker?.available ? "online" : "offline"} label={emailServiceStatusLabel(broker?.available ? "online" : "offline")} /> · {formatDateTime(broker?.heartbeatAt)}</dd></div>
      </dl>
      {latest ? <div className="rc-state"><b>{t("最近密钥请求")}</b><span>{t(latest.operation === "install" ? "安装" : "轮换")} · <StatusBadge value={latest.status} label={emailServiceStatusLabel(latest.status)} /> · {latest.requestedBy || "—"} · {formatDateTime(latest.updatedAt)}</span>{latest.errorCode ? <span className="rc-error">{latest.errorCode}</span> : null}</div> : null}
      {canManage ? <div className="rc-form">
        <div className="rc-form rc-form-grid">
          <label><span>Resend API Key</span><input type="password" autoComplete="new-password" value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder="re_…" /></label>
          <label><span>Webhook Secret</span><input type="password" autoComplete="new-password" value={webhookSecret} onChange={event=>setWebhookSecret(event.target.value)} placeholder="whsec_…" /></label>
        </div>
        <p className="rc-help">{t("两项必须同时提交；字段永不预填，成功提交后立即清空。旧版本会保留到新版本完整应用。")}</p>
        <button className="rc-primary" type="button" disabled={busy || secretRequestActive || !status.secretManagement?.browserConfigurable || !validSecrets} onClick={()=>void submitSecrets()}>{busy || secretRequestActive ? t("正在处理…") : t(secretOperation === "install" ? "加密提交配置" : "加密提交轮换")}</button>
      </div> : null}
    </section>

    <section className="rc-panel"><header><div><small>VERIFIED TEST RECIPIENTS</small><h2>{t("测试收件人")}</h2><p>{t("测试地址独立于管理员账号；必须通过邮箱验证码后才能用于投递测试。")}</p></div><span>{recipients.length} {t("个")}</span></header>
      {canManage ? <div className="rc-form">
        <div className="rc-form rc-form-grid">
          <label><span>{t("邮箱地址")}</span><input type="email" autoComplete="off" value={email} onChange={event=>setEmail(event.target.value)} placeholder="qa@example.com" /></label>
          <label><span>{t("地址标签")}</span><input value={label} onChange={event=>setLabel(event.target.value)} maxLength={80} placeholder={t("例如：发布验收邮箱")} /></label>
        </div>
        <button className="rc-primary" type="button" disabled={busy || !email.includes("@") || !label.trim()} onClick={()=>void createRecipient()}>{t("新增并发送验证码")}</button>
      </div> : null}
      {!recipients.length ? <EmptyState title={t("尚无测试收件人")} description={t("新增邮箱并完成验证码验证后，才能发送测试邮件。")}/> : <div className="rc-card-list rc-email-recipient-list">{recipients.map(recipient=><article key={recipient.id}>
        <header><div><b>{recipient.label}</b><small>{recipient.address}</small></div><StatusBadge value={recipient.suppressed ? "suppressed" : recipient.status} label={emailServiceStatusLabel(recipient.suppressed ? "suppressed" : recipient.status)} /></header>
        <dl className="rc-description-list"><div><dt>{t("验证时间")}</dt><dd>{formatDateTime(recipient.verifiedAt)}</dd></div><div><dt>{t("更新时间")}</dt><dd>{formatDateTime(recipient.updatedAt)}</dd></div><div><dt>{t("操作人")}</dt><dd>{recipient.updatedBy || "—"}</dd></div></dl>
        {recipient.status === "pending_verification" ? <label><span>{t("六位验证码")}</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={verificationCodes[recipient.id] ?? ""} onChange={event=>setVerificationCodes(current=>({ ...current,[recipient.id]: event.target.value.replace(/\D/g,"").slice(0,6) }))} /></label> : null}
        {canManage ? <div className="rc-action-row">
          {recipient.status === "pending_verification" ? <><button className="rc-primary" type="button" disabled={busy || (verificationCodes[recipient.id]?.length ?? 0)!==6} onClick={()=>void props.onRecipientVerify({ recipientId: recipient.id,code: verificationCodes[recipient.id] })}>{t("验证")}</button><button className="rc-button" type="button" disabled={busy} onClick={()=>void props.onRecipientResend({ recipientId: recipient.id })}>{t("重发验证码")}</button></> : <button className="rc-button" type="button" disabled={busy} onClick={()=>void props.onRecipientChange({ recipientId: recipient.id,action: recipient.status === "active" ? "disable" : "enable" })}>{t(recipient.status === "active" ? "停用" : "启用")}</button>}
          <button className="rc-button rc-danger-button" type="button" disabled={busy} onClick={()=>void props.onRecipientDelete({ recipientId: recipient.id })}>{t("删除")}</button>
        </div> : null}
      </article>)}</div>}
    </section>

    <section className="rc-panel"><header><div><small>OUTBOUND AUTHORIZATION</small><h2>{t("Provider 外发授权")}</h2><p>{t("密钥和验证事实就绪后，再开启外发；关闭不会删除任何密钥。")}</p></div><StatusBadge value={status.providerAuthorized ? "active" : "disabled"} label={emailServiceStatusLabel(status.providerAuthorized ? "active" : "disabled")} /></header>
      {canManage ? <div className="rc-form"><button className={status.providerAuthorized ? "rc-button rc-danger-button" : "rc-primary"} type="button" disabled={busy} onClick={()=>void props.onConfigurationChange(status.providerAuthorized ? "disable" : "activate")}>{t(status.providerAuthorized ? "关闭 Provider 外发" : "启用 Provider 外发")}</button></div> : null}
    </section>
  </>;
}
