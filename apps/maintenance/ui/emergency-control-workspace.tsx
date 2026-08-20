"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type EmergencyState = {
  active: boolean;
  scope: "platform" | "organization";
  scopeLabel: string;
  affectedCustomers: number;
  reason: string;
  activatedAt: string | null;
  deactivatedAt: string | null;
  demoCloseOnly: true;
};

type PendingAction = "pause_keep" | "pause_demo_close" | "resume";

export function EmergencyControlWorkspace() {
  const resource = useApiData<EmergencyState>("/api/maintenance/trading/emergency-stop", "紧急暂停状态读取失败");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function execute(reason: string) {
    if (!pending) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/maintenance/trading/emergency-stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: pending !== "resume", closePositions: pending === "pause_demo_close", reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "紧急暂停操作失败"));
      setMessage(String(payload.message || "紧急暂停状态已记录；操作详情以审计记录为准。"));
      setPending(null);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "紧急暂停操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取紧急暂停状态…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const state = resource.data;
  return <>
    <PageHeading eyebrow="TRADING SAFETY CONTROL" title="紧急暂停" description="按当前 RBAC 数据范围暂停策略新开仓。所有操作必须填写原因并进入审计记录。" actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button>} />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-panel">
      <header><div><small>{state?.scopeLabel || "当前授权范围"}</small><h2>交易安全状态</h2></div><StatusBadge value={state?.active ? "paused" : "active"} /></header>
      <dl className="rc-description-list">
        <div><dt>作用范围</dt><dd>{state?.scopeLabel || "—"}</dd></div>
        <div><dt>涉及客户</dt><dd>{state?.affectedCustomers ?? "—"}</dd></div>
        <div><dt>最近原因</dt><dd>{state?.reason || "尚无操作记录"}</dd></div>
        <div><dt>启用时间</dt><dd>{formatDateTime(state?.activatedAt)}</dd></div>
      </dl>
      <div className="rc-callout">自动平仓严格限制为已授权的 OKX Demo 账户。不会连接生产交易账户，也不会把未执行仓位标记为已平仓。</div>
      <div className="rc-action-row">
        {state?.active
          ? <button className="rc-primary" type="button" onClick={() => setPending("resume")}>解除紧急暂停</button>
          : <>
            <button className="rc-button" type="button" onClick={() => setPending("pause_keep")}>暂停新开仓并保留仓位</button>
            <button className="rc-button rc-danger-button" type="button" onClick={() => setPending("pause_demo_close")}>暂停并处理 OKX Demo 仓位</button>
          </>}
      </div>
    </section>
    <ConfirmActionDialog
      open={Boolean(pending)}
      title={pending === "resume" ? "解除紧急暂停" : pending === "pause_demo_close" ? "暂停并处理 OKX Demo 仓位" : "暂停新开仓并保留仓位"}
      description={pending === "resume" ? "解除后策略不会自动恢复，客户需要自行重新启动。请填写解除依据。" : pending === "pause_demo_close" ? "系统将暂停新开仓，并仅向合规的 OKX Demo 账户发送平仓请求。请填写审批或事故原因。" : "系统将暂停新开仓，不发送任何平仓订单。请填写审批或事故原因。"}
      confirmLabel={pending === "resume" ? "确认解除" : "确认暂停"}
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={(reason) => void execute(reason)}
    />
  </>;
}
