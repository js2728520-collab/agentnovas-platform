"use client";

import { useMemo,useState } from "react";

import { emailDeliveryErrorKind } from "@/packages/notifications/src/email-service-management";
import { EmptyState, StatusBadge } from "../page-state";
import { emailDeliveryErrorMessage, emailServiceStatusLabel } from "./presentation";
import type { EmailServiceManagerProps } from "./types";

type Props = EmailServiceManagerProps;

export function EmailServiceTests({ status,tests,recipients,busy,translate = value=>value,formatDateTime,onSendTest,onRefresh }: Props) {
  const t=translate;
  const available=useMemo(()=>recipients.filter(item=>item.status==="active" && !item.suppressed),[recipients]);
  const [recipientId,setRecipientId]=useState("");
  const selectedRecipientId=available.some(item=>item.id===recipientId) ? recipientId : available[0]?.id ?? "";
  const recipient=available.find(item=>item.id===selectedRecipientId) ?? null;
  const sendDisabled=busy || !recipient || status.effectiveStatus==="unconfigured" || status.effectiveStatus==="disabled";
  async function send() {
    if (!recipient) return;
    await onSendTest(recipient.id);
  }
  return <>
    <section className="rc-panel"><header><div><small>DELIVERY TEST</small><h2>{t("发送测试邮件")}</h2><p>{t("从已验证地址中明确选择目标；排队不代表已发送，发送也不代表已送达。")}</p></div><StatusBadge value={recipient ? "authorized" : "not_authorized"} label={emailServiceStatusLabel(recipient ? "authorized" : "not_authorized")} /></header>
      {available.length ? <div className="rc-form"><label htmlFor="email-test-recipient"><span>{t("本次收件人")}</span><select id="email-test-recipient" value={selectedRecipientId} onChange={event=>setRecipientId(event.target.value)}>{available.map(item=><option key={item.id} value={item.id}>{item.label} · {item.address}</option>)}</select></label><p className="rc-help"><strong>{recipient?.address}</strong> · {t("已验证且未被抑制")}</p><div className="rc-action-row"><button className="rc-primary" type="button" disabled={sendDisabled} onClick={()=>void send()}>{busy ? t("正在处理…") : t("发送测试邮件")}</button><button className="rc-button" type="button" disabled={busy} onClick={()=>void onRefresh()}>{t("刷新状态")}</button></div></div> : <EmptyState title={t("没有可用的测试收件人")} description={t("请先在配置中新增邮箱并完成验证码验证。")}/>}
    </section>
    <section className="rc-panel"><header><div><small>DELIVERY HISTORY</small><h2>{t("测试与投递记录")}</h2></div><span>{tests.length} {t("条")}</span></header>
      {!tests.length ? <EmptyState title={t("尚无测试记录")} description={t("发送后，排队、发送和 Webhook 最终状态会显示在这里。")}/> : <div className="rc-card-list">{tests.map(item=>{
        const error=emailDeliveryErrorKind(item.lastErrorCode);
        return <article key={item.id}><header><div><b>{item.recipient}</b><small>{item.id}</small></div><StatusBadge value={item.status} label={emailServiceStatusLabel(item.status)} /></header><dl className="rc-description-list"><div><dt>{t("排队")}</dt><dd>{formatDateTime(item.queuedAt)}</dd></div><div><dt>{t("发送")}</dt><dd>{formatDateTime(item.sentAt)}</dd></div><div><dt>Webhook</dt><dd>{item.providerEventType || t("尚无事件")} · {formatDateTime(item.providerEventAt)}</dd></div><div><dt>Provider ID</dt><dd>{item.providerMessageReference || "—"}</dd></div></dl>{error ? <p className="rc-error" role="alert">{t("错误")}：{error.code} · {t(emailDeliveryErrorMessage(error.kind))}</p> : null}</article>;
      })}</div>}
    </section>
  </>;
}
