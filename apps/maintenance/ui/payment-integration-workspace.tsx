"use client";

import { useState, type KeyboardEvent } from "react";

import { apiErrorMessage, formatDateTime, type MaintenancePaymentProvider } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { encryptPaymentSecretPayload } from "@/packages/ui/src/payment-service-manager/browser-encryption";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type WorkspaceTab = "overview" | "configuration" | "tests";
const workspaceTabs: readonly WorkspaceTab[] = ["overview", "configuration", "tests"];
type PaymentCommand = { provider: MaintenancePaymentProvider; kind: "activate" | "disable" | "configure" | "test" | "callbackTest" };
type SecretRequest = {
  id: string; operation: "install" | "rotate"; status: "pending" | "applying" | "applied" | "failed" | "superseded";
  configurationVersion: string | null; configurationFingerprint: string | null; errorCode: string | null;
  requestedAt: string | null; appliedAt: string | null;
};
type SecretManagement = {
  browserConfigurable: boolean;
  broker: { available: boolean; keyId: string | null; heartbeatAt: string | null; lastErrorCode: string | null };
  latestRequest: SecretRequest | null;
};
type PaymentTestRun = {
  id: string; providerConfigId: string; kind: "provider_connectivity" | "callback_readiness";
  status: "passed" | "failed"; configurationVersion: string; errorCode: string | null;
  actor: string | null; reason: string; startedAt: string; completedAt: string;
};

function commandKey(kind: string) { return `payment-${kind}-${Date.now()}-${crypto.randomUUID()}`; }
const terminalSecretStatuses = new Set(["applied", "failed", "superseded"]);

export function PaymentIntegrationWorkspace({ canManage }: { canManage: boolean }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{
    providers: MaintenancePaymentProvider[]; secretManagement: SecretManagement; testHistory: PaymentTestRun[];
  }>(
    "/api/maintenance/payment-providers", t("支付配置读取失败"),
  );
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [auditReason, setAuditReason] = useState("");
  const [statusReason, setStatusReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [mainCoinType, setMainCoinType] = useState("");
  const [tokenCoinType, setTokenCoinType] = useState("");
  const [walletId, setWalletId] = useState("");
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [addressRequestCoinField, setAddressRequestCoinField] = useState<"mainCoinType" | "coinType">("mainCoinType");

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: WorkspaceTab) {
    const currentIndex = workspaceTabs.indexOf(current);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? workspaceTabs.length - 1
        : event.key === "ArrowRight" ? (currentIndex + 1) % workspaceTabs.length
          : event.key === "ArrowLeft" ? (currentIndex - 1 + workspaceTabs.length) % workspaceTabs.length
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = workspaceTabs[nextIndex];
    setTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`payment-${nextTab}-tab`)?.focus());
  }

  async function responsePayload(response: Response, fallback: string) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = apiErrorMessage(payload, fallback);
      throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
    }
    return payload as Record<string, unknown>;
  }

  async function submit(commandToRun: PaymentCommand, reason: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const test = commandToRun.kind === "test";
      const callbackTest = commandToRun.kind === "callbackTest";
      const configure = commandToRun.kind === "configure";
      const endpoint = test ? "test" : callbackTest ? "callback-test" : configure ? "configuration" : "status";
      const response = await fetch(`/api/maintenance/payment-providers/${encodeURIComponent(commandToRun.provider.id)}/${endpoint}`, {
        method: test || callbackTest ? "POST" : "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": commandKey(commandToRun.kind) },
        body: JSON.stringify(test || callbackTest ? { reason }
          : configure ? { reason, mainCoinType, tokenCoinType, walletId: walletId || null }
            : { reason, status: commandToRun.kind === "activate" ? "active" : "disabled" }),
      });
      await responsePayload(response, t("优盾操作失败"));
      setMessage(test ? t("Provider 连通与目标 USDT 币种映射测试已通过；没有创建地址或发起转账。")
        : callbackTest ? t("公网回调已到达验签路由并收到预期拒绝；没有写入订单或资金事实。")
          : configure ? t("币种映射已保存，Provider 与回调测试均需重新执行。")
            : commandToRun.kind === "activate" ? t("优盾充值通道已启用。")
              : t("优盾充值通道已停用；已有订单证据仍保留。"));
      if (commandToRun.kind === "activate" || commandToRun.kind === "disable") setStatusReason("");
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("优盾操作失败")); }
    finally { setBusy(false); }
  }

  async function waitForSecretRequest(id: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 1_000));
      const response = await fetch(`/api/maintenance/payment-secrets/requests/${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await responsePayload(response, t("支付配置状态读取失败"));
      const request = payload.request as SecretRequest | undefined;
      if (request && terminalSecretStatuses.has(request.status)) return request;
    }
    return null;
  }

  async function submitSecretConfiguration() {
    if (busy || !hasValidAuditReason(auditReason)) return;
    setBusy(true); setMessage("");
    try {
      const keyResponse = await fetch("/api/maintenance/payment-secrets/public-key", { cache: "no-store" });
      const publicConfiguration = await responsePayload(keyResponse, t("支付密钥 Broker 公钥读取失败"));
      const envelope = await encryptPaymentSecretPayload({
        keyId: String(publicConfiguration.keyId ?? ""), publicKeyPem: String(publicConfiguration.publicKeyPem ?? ""),
        configuration: {
          provider: "udun", gatewayBaseUrl: gatewayBaseUrl.trim(), merchantId: merchantId.trim(),
          apiKey, callbackUrl: callbackUrl.trim(), addressRequestCoinField,
        },
      });
      const operation = resource.data?.secretManagement.latestRequest?.status === "applied" ? "rotate" : "install";
      const response = await fetch("/api/maintenance/payment-secrets/requests", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": commandKey(`secret-${operation}`) },
        body: JSON.stringify({ operation, envelope, reason: auditReason.trim() }),
      });
      const payload = await responsePayload(response, t("支付配置提交失败"));
      setApiKey("");
      const request = payload.request as SecretRequest | undefined;
      if (!request) throw new Error(t("支付配置请求响应无效"));
      const terminal = await waitForSecretRequest(request.id);
      setMessage(terminal?.status === "applied"
        ? t("支付配置已原子应用。请继续保存币种映射并完成两项测试。")
        : terminal?.status === "failed" ? `${t("支付配置应用失败")} · ${terminal.errorCode ?? "UNKNOWN"}`
          : t("支付配置正在由独立 Broker 应用，可稍后刷新查看结果。"));
      await resource.refresh();
    } catch (error) {
      setApiKey("");
      setMessage(error instanceof Error ? error.message : t("支付配置提交失败"));
    } finally { setBusy(false); }
  }

  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取支付配置…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const provider = resource.data?.providers.find(item => item.provider === "udun");
  const secret = resource.data?.secretManagement;

  return <>
    <PageHeading eyebrow="PAYMENT INTEGRATION · DEPOSIT ONLY" title={t("优盾充值通道")}
      description={t("完成商户配置、币种验证、公网回调和启用 Gate；到账仍必须由 Operations 双人复核入账。")}
      actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()} disabled={resource.loading}>{t("刷新状态")}</button>} />
    <div className="rc-hub-tabs" aria-label={t("支付服务页面")} role="tablist">
      {workspaceTabs.map(value => <button key={value} type="button"
        id={`payment-${value}-tab`} role="tab" aria-controls={`payment-${value}-panel`}
        aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
        onClick={() => setTab(value)} onKeyDown={event => handleTabKeyDown(event, value)}>
        {t(value === "overview" ? "概况" : value === "configuration" ? "配置" : "测试与记录")}
      </button>)}
    </div>
    <div id={`payment-${tab}-panel`} role="tabpanel" aria-labelledby={`payment-${tab}-tab`}>
      {!provider ? <EmptyState title={t("未配置支付服务")} description={t("客户端不会生成地址或二维码。")}/>
      : tab === "overview" ? <>
        <div className="rc-callout" role="status">{provider.activationReady
          ? t("全部启用 Gate 已满足；只有数据库状态切为 active 后客户端才可生成地址。")
          : `${t("尚未满足启用条件")}：${provider.activationBlockers.join(" · ") || t("等待刷新")}`}</div>
        <section className="rc-panel"><header><div><small>READINESS</small><h2>{t("充值闭环状态")}</h2>
          <p>{t("配置存在、测试通过和通道启用是三个不同事实。")}</p></div><StatusBadge value={provider.effectiveStatus} /></header>
          <dl className="rc-description-list">
            <div><dt>{t("配置状态")}</dt><dd>{provider.hasSecret ? t("已配置（无法回显）") : t("未配置")}</dd></div>
            <div><dt>Secret Broker</dt><dd>{provider.brokerAvailable ? t("在线") : t("不可用")}</dd></div>
            <div><dt>{t("配置版本")}</dt><dd>{provider.configurationVersion ?? "—"}</dd></div>
            <div><dt>{t("配置指纹")}</dt><dd>{provider.configurationFingerprint ?? "—"}</dd></div>
            <div><dt>{t("币种映射")}</dt><dd>{provider.coinMappingConfigured ? t("已配置") : t("未配置")}</dd></div>
            <div><dt>{t("外发授权")}</dt><dd>{provider.providerAuthorized ? t("已开启") : t("已关闭")}</dd></div>
            <div><dt>{t("Provider 测试")}</dt><dd>{provider.lastTestAt ? `${formatDateTime(provider.lastTestAt, locale)} · ${provider.lastTestStatus}` : t("尚未测试")}</dd></div>
            <div><dt>{t("公网回调测试")}</dt><dd>{provider.lastCallbackTestAt ? `${formatDateTime(provider.lastCallbackTestAt, locale)} · ${provider.lastCallbackTestStatus}` : t("尚未测试")}</dd></div>
          </dl>
          {canManage && <footer className="rc-action-row"><InlineAuditReasonField id="payment-status-reason" value={statusReason}
            onChange={setStatusReason} label={t("启停原因")} hint={t("启用后客户可请求真实地址；停用不会删除已有订单。")} />
            {provider.configuredStatus === "active"
              ? <button className="rc-button rc-button-danger" type="button" disabled={busy || !hasValidAuditReason(statusReason)} onClick={() => void submit({ provider, kind: "disable" }, statusReason.trim())}>{t("停用通道")}</button>
              : <button className="rc-button rc-button-primary" type="button" disabled={busy || !provider.activationReady || !hasValidAuditReason(statusReason)} onClick={() => void submit({ provider, kind: "activate" }, statusReason.trim())}>{t("启用充值")}</button>}
          </footer>}
        </section>
      </> : tab === "configuration" ? <>
        <div className="rc-callout rc-callout-warning" role="note"><strong>{t("商户配置只写且无法回显。")}</strong>
          {t("安装或轮换必须填写全部字段；浏览器加密后由独立 Broker 原子应用，Web 与数据库不接触明文。")}</div>
        <section className="rc-panel"><header><div><small>SECRET CUSTODY</small><h2>{t("商户配置")}</h2>
          <p>{secret?.broker.available ? t("Payment Secret Broker 在线。") : t("Payment Secret Broker 不可用，配置提交已失败关闭。")}</p></div></header>
          <div className="rc-form rc-form-grid">
            <label><span>{t("优盾 HTTPS 网关")}</span><input value={gatewayBaseUrl} onChange={event => setGatewayBaseUrl(event.target.value)} placeholder="https://sigxx.udun.io" autoComplete="off" /></label>
            <label><span>{t("商户号")}</span><input value={merchantId} onChange={event => setMerchantId(event.target.value)} inputMode="numeric" autoComplete="off" /></label>
            <label><span>API Key</span><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" /></label>
            <label><span>{t("公网回调地址")}</span><input value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} placeholder="https://main-test.agentnovas.com/api/integrations/payments/udun/webhook" autoComplete="off" /></label>
            <label><span>{t("地址请求字段版本")}</span><select value={addressRequestCoinField} onChange={event => setAddressRequestCoinField(event.target.value as "mainCoinType" | "coinType")}><option value="mainCoinType">{t("mainCoinType（当前官方文档）")}</option><option value="coinType">{t("coinType（旧英文协议）")}</option></select></label>
            <InlineAuditReasonField id="payment-configuration-reason" value={auditReason} onChange={setAuditReason} label={t("配置与测试原因")} />
          </div>
          <footer className="rc-action-row"><button className="rc-button rc-button-primary" type="button"
            disabled={!canManage || busy || !secret?.browserConfigurable || !gatewayBaseUrl.trim() || !merchantId.trim() || !apiKey || !callbackUrl.trim() || !hasValidAuditReason(auditReason)}
            onClick={() => void submitSecretConfiguration()}>{provider.hasSecret ? t("轮换完整商户配置") : t("安装商户配置")}</button></footer>
        </section>
        <section className="rc-panel"><header><div><small>COIN MAPPING</small><h2>{t("USDT / TRC20 映射")}</h2>
          <p>{t("编号必须来自当前商户的支持币种接口，不能照抄示例。修改后两项测试都会失效。")}</p></div></header>
          <div className="rc-form rc-form-grid">
            <label><span>{t("主币种编号")}</span><input name="mainCoinType" value={mainCoinType} onChange={event => setMainCoinType(event.target.value)} /></label>
            <label><span>{t("USDT 币种编号")}</span><input name="tokenCoinType" value={tokenCoinType} onChange={event => setTokenCoinType(event.target.value)} /></label>
            <label><span>{t("钱包编号（可选）")}</span><input value={walletId} onChange={event => setWalletId(event.target.value)} /></label>
          </div>
          <footer className="rc-action-row"><button className="rc-button" type="button" disabled={!canManage || busy || provider.configuredStatus !== "disabled" || !mainCoinType.trim() || !tokenCoinType.trim() || !hasValidAuditReason(auditReason)} onClick={() => void submit({ provider, kind: "configure" }, auditReason.trim())}>{t("保存币种映射")}</button></footer>
        </section>
      </> : <section className="rc-panel"><header><div><small>VERIFICATION</small><h2>{t("测试与记录")}</h2>
        <p>{t("Provider 测试核对真实币种映射；回调测试核对 DNS、TLS、Nginx 和应用验签路由。两者都不会创建地址或转账。")}</p></div></header>
        <dl className="rc-description-list">
          <div><dt>{t("最近 Provider 测试")}</dt><dd>{provider.lastTestAt ? `${formatDateTime(provider.lastTestAt, locale)} · ${provider.lastTestStatus}` : t("尚未测试")}</dd></div>
          <div><dt>{t("Provider 错误码")}</dt><dd>{provider.lastErrorCode ?? "—"}</dd></div>
          <div><dt>{t("最近回调测试")}</dt><dd>{provider.lastCallbackTestAt ? `${formatDateTime(provider.lastCallbackTestAt, locale)} · ${provider.lastCallbackTestStatus}` : t("尚未测试")}</dd></div>
          <div><dt>{t("回调错误码")}</dt><dd>{provider.lastCallbackErrorCode ?? "—"}</dd></div>
          <div><dt>{t("最近配置请求")}</dt><dd>{secret?.latestRequest ? `${secret.latestRequest.status} · ${secret.latestRequest.configurationFingerprint ?? "—"}` : t("尚无记录")}</dd></div>
        </dl>
        <div className="rc-form"><InlineAuditReasonField id="payment-test-reason" value={auditReason} onChange={setAuditReason} label={t("测试原因")} /></div>
        <footer className="rc-action-row">
          <button className="rc-button" type="button" disabled={!canManage || busy || !provider.hasSecret || !provider.coinMappingConfigured || !hasValidAuditReason(auditReason)} onClick={() => void submit({ provider, kind: "test" }, auditReason.trim())}>{t("Provider 连通测试与币种校验")}</button>
          <button className="rc-button" type="button" disabled={!canManage || busy || !provider.hasSecret || !hasValidAuditReason(auditReason)} onClick={() => void submit({ provider, kind: "callbackTest" }, auditReason.trim())}>{t("测试公网回调")}</button>
        </footer>
        <div className="rc-table-wrap"><table><thead><tr><th>{t("测试目标")}</th><th>{t("结果")}</th><th>{t("配置版本")}</th><th>{t("操作者与原因")}</th><th>{t("开始 / 结束")}</th></tr></thead><tbody>
          {(resource.data?.testHistory ?? []).filter(run => run.providerConfigId === provider.id).map(run => <tr key={run.id}>
            <td>{t(run.kind === "provider_connectivity" ? "Provider 连通与币种" : "公网回调链路")}</td>
            <td><StatusBadge value={run.status} /><small>{run.errorCode ?? t("无错误")}</small></td>
            <td>{run.configurationVersion}</td>
            <td>{run.actor ?? "—"}<small>{run.reason}</small></td>
            <td>{formatDateTime(run.startedAt, locale)}<small>{formatDateTime(run.completedAt, locale)}</small></td>
          </tr>)}
          {!(resource.data?.testHistory ?? []).some(run => run.providerConfigId === provider.id) && <tr><td colSpan={5}>{t("尚无支付测试记录")}</td></tr>}
        </tbody></table></div>
      </section>}
    </div>
    <div className="rc-live" aria-live="polite">{message}</div>
  </>;
}
