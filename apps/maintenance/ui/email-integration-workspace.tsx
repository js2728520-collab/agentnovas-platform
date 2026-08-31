"use client";

import { useEffect,useRef,useState } from "react";

import { apiErrorMessage,formatDateTime,type MaintenanceEmailStatus } from "@/packages/contracts/src/riverton-ui";
import type { EmailConfigurationAction,EmailRecipientAction,EmailSecretOperation,EmailTestRecord,EmailTestRecipient } from "@/packages/notifications/src/email-service-management";
import { encryptEmailSecretPayload } from "@/packages/ui/src/email-service-manager/browser-encryption";
import { EmailServiceManager } from "@/packages/ui/src/email-service-manager/email-service-manager";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { ErrorState,LoadingState,PageHeading } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type EmailTestHistory={ tests: EmailTestRecord[];limit: number;hasMore: boolean };
type EmailRecipientList={ recipients: EmailTestRecipient[] };

export function EmailIntegrationWorkspace({ canManage }: { canManage: boolean }) {
  const { locale,t }=useAppLocale();
  const status=useApiData<MaintenanceEmailStatus>("/api/maintenance/email/status",t("邮件状态读取失败"));
  const history=useApiData<EmailTestHistory>(canManage ? "/api/maintenance/email/tests?limit=20" : null,t("邮件测试记录读取失败"));
  const recipients=useApiData<EmailRecipientList>(canManage ? "/api/maintenance/email/recipients" : null,t("测试收件人读取失败"));
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [pending,setPending]=useState<{ id: string;recipient: string } | null>(null);
  const polling=useRef<AbortController | null>(null);
  useEffect(()=>()=>polling.current?.abort(),[]);

  async function refreshAll() {
    await Promise.all([status.refresh(),history.refresh(),recipients.refresh()]);
  }

  async function mutate(url: string,method: "POST" | "PATCH" | "DELETE",body: unknown,success: string) {
    setBusy(true);setMessage("");
    try {
      const response=await fetch(url,{ method,headers: { "content-type": "application/json","idempotency-key": crypto.randomUUID() },body: JSON.stringify(body) });
      const payload=await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload,t("邮件配置更新失败")));
      setMessage(success);
      await refreshAll();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("邮件配置更新失败"));
      return false;
    } finally { setBusy(false); }
  }

  async function watchDelivery(deliveryId: string,recipient: string) {
    polling.current?.abort();
    const controller=new AbortController();polling.current=controller;
    const startedAt=Date.now();
    while (!controller.signal.aborted && Date.now()-startedAt<30_000) {
      await new Promise(resolve=>window.setTimeout(resolve,2_000));
      if (controller.signal.aborted) return;
      try {
        const response=await fetch("/api/maintenance/email/tests?limit=20",{ cache: "no-store",signal: controller.signal });
        const payload=await response.json().catch(()=>({})) as Partial<EmailTestHistory>;
        if (!response.ok || !Array.isArray(payload.tests)) continue;
        history.setData(payload as EmailTestHistory);
        const delivery=payload.tests.find(item=>item.id===deliveryId);
        if (delivery?.status==="delivered" || delivery?.status==="failed") {
          setMessage(delivery.status==="delivered" ? `${t("测试邮件已送达")} ${recipient}` : `${t("测试邮件投递失败")}：${delivery.lastErrorCode || "UNKNOWN"}`);
          setPending(null);await status.refresh();return;
        }
      } catch (error) { if (controller.signal.aborted) return;void error; }
    }
    if (!controller.signal.aborted) { setMessage(t("测试仍在处理中；可继续查看记录，系统不会把超时描述为失败。"));setPending(null); }
  }

  async function watchSecretRequest(requestId: string) {
    polling.current?.abort();
    const controller=new AbortController();polling.current=controller;
    const startedAt=Date.now();
    while (!controller.signal.aborted && Date.now()-startedAt<45_000) {
      await new Promise(resolve=>window.setTimeout(resolve,2_000));
      if (controller.signal.aborted) return;
      try {
        const response=await fetch("/api/maintenance/email/secrets",{ cache: "no-store",signal: controller.signal });
        const payload=await response.json().catch(()=>({})) as MaintenanceEmailStatus["secretManagement"];
        if (!response.ok || payload?.latestRequest?.id!==requestId) continue;
        await status.refresh();
        if (payload.latestRequest.status==="applied") {
          setMessage(t("密钥配置已由 Broker 原子应用；页面和 Worker 已切换到新版本。"));
          return;
        }
        if (payload.latestRequest.status==="failed") {
          setMessage(`${t("密钥配置应用失败")}：${payload.latestRequest.errorCode || "EMAIL_SECRET_APPLY_FAILED"}`);
          return;
        }
      } catch (error) { if (controller.signal.aborted) return;void error; }
    }
    if (!controller.signal.aborted) setMessage(t("密钥配置仍在处理中；旧配置继续有效，可刷新查看最新状态。"));
  }

  async function configurationChange(action: EmailConfigurationAction) {
    return mutate("/api/maintenance/email/configuration","PATCH",{ action },t(action==="activate" ? "Provider 外发授权已启用" : "Provider 外发授权已关闭"));
  }

  async function secretChange(input: { operation: EmailSecretOperation;apiKey: string;webhookSecret: string }) {
    const broker=status.data?.secretManagement?.broker;
    if (!broker?.available || !broker.keyId || !broker.publicKeyPem) { setMessage(t("Secret Broker 不可用，请刷新后重试"));return false; }
    setBusy(true);setMessage("");
    try {
      const envelope=await encryptEmailSecretPayload({ keyId: broker.keyId,publicKeyPem: broker.publicKeyPem,resendApiKey: input.apiKey,resendWebhookSecret: input.webhookSecret });
      const response=await fetch("/api/maintenance/email/secrets",{ method: "POST",headers: { "content-type": "application/json","idempotency-key": crypto.randomUUID() },body: JSON.stringify({ operation: input.operation,envelope }) });
      const payload=await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload,t("密钥请求提交失败")));
      const requestId=String(payload?.request?.id || "");
      setMessage(t("密钥密文请求已提交；应用完成前旧配置继续有效。"));
      await refreshAll();
      if (requestId) void watchSecretRequest(requestId);
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : t("密钥请求提交失败"));return false; }
    finally { setBusy(false); }
  }

  async function sendTest(recipientId: string) {
    setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/maintenance/email/test",{ method: "POST",headers: { "content-type": "application/json","idempotency-key": crypto.randomUUID() },body: JSON.stringify({ recipientId }) });
      const payload=await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload,t("邮件测试失败")));
      const recipient=String(payload.recipient || t("未知收件人"));
      const deliveryId=String(payload.deliveryId || "");
      setMessage(`${t("测试邮件已入队")} · ${recipient} · ${deliveryId}`);
      if (deliveryId) { setPending({ id: deliveryId,recipient });void watchDelivery(deliveryId,recipient); }
      await refreshAll();return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : t("邮件测试失败"));return false; }
    finally { setBusy(false); }
  }

  if (status.loading && !status.data) return <LoadingState label={t("正在读取邮件配置…")} />;
  if (status.error && !status.data) return <ErrorState message={status.error} retry={status.refresh} />;
  if (!status.data) return <ErrorState message={t("邮件状态不可用")} retry={status.refresh} />;
  return <>
    <PageHeading eyebrow="EMAIL SERVICE" title={t("邮件服务")} description={t("配置 Resend、验证独立测试收件人，并跟踪到 Webhook 最终投递证据。")}/>
    {history.error || recipients.error ? <div className="rc-state rc-error" role="alert">{history.error || recipients.error}</div> : null}
    <EmailServiceManager
      status={status.data} tests={history.data?.tests ?? []} recipients={recipients.data?.recipients ?? []}
      canManage={canManage} busy={busy || Boolean(pending)} message={message} translate={t}
      formatDateTime={value=>formatDateTime(value,locale)}
      onConfigurationChange={configurationChange}
      onSecretChange={secretChange}
      onRecipientCreate={input=>mutate("/api/maintenance/email/recipients","POST",input,t("收件地址已新增，验证码已排队"))}
      onRecipientVerify={input=>mutate(`/api/maintenance/email/recipients/${encodeURIComponent(input.recipientId)}/verification`,"POST",{ action: "verify",code: input.code },t("收件地址验证成功"))}
      onRecipientResend={input=>mutate(`/api/maintenance/email/recipients/${encodeURIComponent(input.recipientId)}/verification`,"POST",{ action: "resend" },t("验证码已重新排队"))}
      onRecipientChange={(input: { recipientId: string;action: EmailRecipientAction })=>mutate(`/api/maintenance/email/recipients/${encodeURIComponent(input.recipientId)}`,"PATCH",{ action: input.action },t(input.action==="enable" ? "收件地址已启用" : "收件地址已停用"))}
      onRecipientDelete={input=>mutate(`/api/maintenance/email/recipients/${encodeURIComponent(input.recipientId)}`,"DELETE",{},t("收件地址已删除"))}
      onSendTest={sendTest}
      onRefresh={refreshAll}
    />
  </>;
}
