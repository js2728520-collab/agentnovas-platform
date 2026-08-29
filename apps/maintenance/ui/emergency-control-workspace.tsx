"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type EmergencyState = {
  active: boolean;
  scope: "platform" | "organization";
  scopeLabel: string;
  affectedCustomers: number;
  affectedPortfolios: number;
  activePortfolios: number;
  closeOnlyPortfolios: number;
  readOnlyPortfolios: number;
  reason: string;
  activatedAt: string | null;
  deactivatedAt: string | null;
  paperAccessOnly: true;
  platformDemoUnaffected: true;
  demoControlPath: string;
};

type PendingAction = "pause" | "resume";

export function EmergencyControlWorkspace() {
  const { locale, t } = useAppLocale();
  const resource = useApiData<EmergencyState>("/api/maintenance/trading/emergency-stop", t("紧急暂停状态读取失败"));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const commandKey = useRef(crypto.randomUUID());

  async function execute(action: PendingAction) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/maintenance/trading/emergency-stop", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": commandKey.current },
        body: JSON.stringify({ active: action === "pause", reason: reason.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, t("紧急暂停操作失败")));
      commandKey.current = crypto.randomUUID();
      setMessage(String(payload.message || t("紧急暂停状态已记录；操作详情以审计记录为准。")));
      setReason("");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("紧急暂停操作失败"));
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取紧急暂停状态…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const state = resource.data;
  return <>
    <PageHeading eyebrow="PAPER SAFETY CONTROL" title={t("紧急暂停")} description={t("按当前 RBAC 数据范围暂停官方 Paper 新开仓。所有操作必须填写原因并进入审计记录。")} actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button>} />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel">
      <header><div><small>{state ? state.scope === "platform" ? t("全平台") : state.scopeLabel : t("当前授权范围")}</small><h2>{t("交易安全状态")}</h2></div><StatusBadge value={state?.active ? "paused" : "active"} /></header>
      <dl className="rc-description-list">
        <div><dt>{t("作用范围")}</dt><dd>{state ? state.scope === "platform" ? t("全平台") : state.scopeLabel : "—"}</dd></div>
        <div><dt>{t("涉及客户")}</dt><dd>{state?.affectedCustomers ?? "—"}</dd></div>
        <div><dt>{t("官方 Paper 组合")}</dt><dd>{state?.affectedPortfolios ?? "—"}</dd></div>
        <div><dt>{t("仅允许平仓 / 只读")}</dt><dd>{state ? `${state.closeOnlyPortfolios} / ${state.readOnlyPortfolios}` : "—"}</dd></div>
        <div><dt>{t("最近原因")}</dt><dd>{state?.reason || t("尚无操作记录")}</dd></div>
        <div><dt>{t("启用时间")}</dt><dd>{formatDateTime(state?.activatedAt, locale)}</dd></div>
      </dl>
      <div className="rc-callout">
        {t("此处只改变官方 Paper 组合的新开仓与访问状态，不发送任何订单，也不改变平台 Demo kill switch。")}
        {t("如需处理平台测试账户，请前往")} <Link href={state?.demoControlPath || "/integrations?tab=demo"}>{t("Demo 交易所控制")}</Link>。
      </div>
      <div className="rc-form"><InlineAuditReasonField id="emergency-control-reason" value={reason} onChange={setReason} label={t("审批或事故原因")} hint={state?.active ? t("解除后组合不会自动恢复 active；仍需由会员或客户状态流程核验资格。") : t("暂停只会将范围内 active 的官方 Paper 组合改为仅允许平仓或只读，不发送订单。")} /></div>
      <div className="rc-action-row">
        {state?.active
          ? <button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(reason)} onClick={() => void execute("resume")}>{t("解除紧急暂停")}</button>
          : <button className="rc-button rc-danger-button" type="button" disabled={busy || !hasValidAuditReason(reason)} onClick={() => void execute("pause")}>{t("暂停官方 Paper 新开仓")}</button>}
      </div>
    </section>
  </>;
}
