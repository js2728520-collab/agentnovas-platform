"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime, type MaintenancePaymentProvider } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type PaymentCommand = { provider: MaintenancePaymentProvider; kind: "activate" | "disable" | "configure" | "test" };

function commandKey(kind: string) { return `payment-${kind}-${Date.now()}-${crypto.randomUUID()}`; }

export function PaymentIntegrationWorkspace({ canManage }: { canManage: boolean }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ providers: MaintenancePaymentProvider[] }>("/api/maintenance/payment-providers", t("支付配置读取失败"));
  const [auditReason, setAuditReason] = useState("");
  const [statusReason, setStatusReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [mainCoinType, setMainCoinType] = useState("195");
  const [tokenCoinType, setTokenCoinType] = useState("");
  const [walletId, setWalletId] = useState("");

  async function submit(commandToRun: PaymentCommand, reason: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const test = commandToRun.kind === "test";
      const configure = commandToRun.kind === "configure";
      const response = await fetch(`/api/maintenance/payment-providers/${encodeURIComponent(commandToRun.provider.id)}/${test ? "test" : configure ? "configuration" : "status"}`, {
        method: test ? "POST" : "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": commandKey(commandToRun.kind) },
        body: JSON.stringify(test ? { reason } : configure ? { reason, mainCoinType, tokenCoinType, walletId: walletId || null } : { reason, status: commandToRun.kind === "activate" ? "active" : "disabled" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = t("优盾操作失败");
        const detail = apiErrorMessage(payload, fallback);
        throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
      }
      setMessage(test ? t("优盾签名接口连通测试已通过；未创建地址、未发起转账。") : configure ? t("优盾币种映射已保存，必须重新连通测试后才能启用。") : commandToRun.kind === "activate" ? t("优盾充值通道已启用。") : t("优盾充值通道已停用。现有订单仍保留只读证据。"));
      if (commandToRun.kind === "activate" || commandToRun.kind === "disable") setStatusReason("");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("优盾操作失败"));
    } finally { setBusy(false); }
  }

  function submitDirect(provider: MaintenancePaymentProvider, kind: "configure" | "test") {
    void submit({ provider, kind }, auditReason.trim());
  }

  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取支付配置…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  return <>
    <PageHeading
      eyebrow="PAYMENT INTEGRATION · DEPOSIT ONLY"
      title={t("优盾充值通道")}
      description={t("只接入充值地址生成、签名回调和双人复核入账；提现、划转、自动扣款与密钥回显均不可用。")}
      actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新状态")}</button>}
    />
    <div className="rc-callout" role="status">{t("有效状态同时取决于数据库开关、运行时商户号/API Key/网关/回调地址和币种映射。配置存在不等于通道正在运行。")}</div>
    {canManage ? <section className="rc-panel"><header><div><small>CONFIGURATION AUDIT</small><h2>{t("充值配置原因")}</h2><p>{t("配置、测试与启停均在页面内填写原因后直接执行，不再弹出二次确认；权限、幂等和服务端安全 Gate 保持不变。")}</p></div></header><div className="rc-form rc-form-grid"><InlineAuditReasonField id="payment-configuration-reason" value={auditReason} onChange={setAuditReason} label={t("配置与测试原因")} /><InlineAuditReasonField id="payment-status-reason" value={statusReason} onChange={setStatusReason} label={t("启停原因")} hint={t("启用后客户端可生成真实充值地址；停用后停止创建新订单。到账仍需双人复核。")} /></div></section> : null}
    <section className="rc-panel">
      <header><div><small>SECURE PROJECTION</small><h2>{t("支付渠道安全状态")}</h2><p>{t("页面只显示是否存在，不显示商户号、API Key、完整网关或回调密文。")}</p></div></header>
      {!resource.data?.providers.length ? <EmptyState title={t("未配置支付服务")} description={t("客户端会收到明确的 503，不会生成地址或二维码。")} />
        : <div className="rc-card-list">{resource.data.providers.map((provider) => <article key={provider.id}>
          <header><div><b>{provider.provider.toUpperCase()}</b><small>{provider.channel} · {provider.network || t("无网络")}</small></div><StatusBadge value={provider.effectiveStatus} /></header>
          <dl className="rc-description-list">
            <div><dt>{t("存储状态")}</dt><dd>{provider.configuredStatus}</dd></div>
            <div><dt>{t("有效状态")}</dt><dd>{provider.effectiveStatus}</dd></div>
            <div><dt>{t("协议")}</dt><dd>{provider.protocol || t("未配置")}</dd></div>
            <div><dt>{t("商户号")}</dt><dd>{provider.merchantConfigured ? t("已配置（不可回显）") : t("未配置")}</dd></div>
            <div><dt>API Key</dt><dd>{provider.hasSecret ? t("已配置（不可回显）") : t("未配置")}</dd></div>
            <div><dt>{t("专属网关")}</dt><dd>{provider.gatewayConfigured ? t("已配置（不可回显）") : t("未配置")}</dd></div>
            <div><dt>{t("回调地址")}</dt><dd>{provider.callbackConfigured ? t("已配置（不可回显）") : t("未配置")}</dd></div>
            <div><dt>{t("币种映射")}</dt><dd>{provider.coinMappingConfigured ? t("已配置") : t("未配置")}</dd></div>
            <div><dt>{t("确认阈值")}</dt><dd>{provider.confirmationThreshold ?? t("未设置")}</dd></div>
            <div><dt>{t("最近测试")}</dt><dd>{provider.lastTestAt ? `${formatDateTime(provider.lastTestAt, locale)} · ${provider.lastTestStatus}` : t("尚未测试")}</dd></div>
            <div><dt>{t("最近错误")}</dt><dd>{provider.lastErrorCode || "—"}</dd></div>
            <div><dt>{t("更新时间")}</dt><dd>{formatDateTime(provider.updatedAt, locale)}</dd></div>
          </dl>
          {canManage && provider.provider === "udun" && <footer className="rc-action-row">
            {provider.configuredStatus === "disabled" && <>
              <label><span>{t("主币种编号")}</span><input value={mainCoinType} onChange={(event) => setMainCoinType(event.target.value)} placeholder={t("TRON 通常为 195")} /></label>
              <label><span>{t("USDT 币种编号")}</span><input value={tokenCoinType} onChange={(event) => setTokenCoinType(event.target.value)} placeholder={t("以商户支持币种接口为准")} /></label>
              <label><span>{t("钱包编号（可选）")}</span><input value={walletId} onChange={(event) => setWalletId(event.target.value)} /></label>
              <button className="rc-button" type="button" disabled={busy || !tokenCoinType.trim() || !hasValidAuditReason(auditReason)} onClick={() => submitDirect(provider, "configure")}>{t("保存币种映射")}</button>
            </>}
            <button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(auditReason)} onClick={() => submitDirect(provider, "test")}>{t("连通测试")}</button>
            {provider.configuredStatus === "active"
              ? <button className="rc-button rc-button-danger" type="button" disabled={busy || !hasValidAuditReason(statusReason)} onClick={() => void submit({ provider, kind: "disable" }, statusReason.trim())}>{t("停用通道")}</button>
              : <button className="rc-button rc-button-primary" type="button" disabled={busy || !hasValidAuditReason(statusReason)} onClick={() => void submit({ provider, kind: "activate" }, statusReason.trim())}>{t("启用充值")}</button>}
          </footer>}
        </article>)}</div>}
    </section>
    <div className="rc-live" aria-live="polite">{message}</div>
  </>;
}
