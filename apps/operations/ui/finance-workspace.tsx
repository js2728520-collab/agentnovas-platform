"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type Settlement = { id: string; kind: string; periodStart: string; periodEnd: string; beneficiaryId: string; amountUsdt: number; network: string; status: string; createdAt: string };
type Collection = { id: string; customerId: string; email: string; settlementId: string; amountUsdt: number; dueAt: string; graceEndsAt: string; status: string; newEntriesAllowed: boolean; remindersSent: number };
type PayoutProfile = { id: string; ownerOrganizationId: string; network: string; address: string; status: string; createdAt: string };

export function FinanceWorkspace({ canRequestAdjustment }: { canRequestAdjustment: boolean }) {
  const [tab, setTab] = useState<"settlements" | "collections" | "payouts" | "adjustments">("settlements");
  return <><PageHeading eyebrow="FINANCE" title="财务结算" description="月报、结算、应收和付款资料；真实付款仍由人工流程完成。" /><nav className="rc-tabs"><button className={tab === "settlements" ? "active" : ""} onClick={() => setTab("settlements")}>结算</button><button className={tab === "collections" ? "active" : ""} onClick={() => setTab("collections")}>应收</button><button className={tab === "payouts" ? "active" : ""} onClick={() => setTab("payouts")}>付款资料</button>{canRequestAdjustment && <button className={tab === "adjustments" ? "active" : ""} onClick={() => setTab("adjustments")}>调整申请</button>}</nav><div className="rc-callout">页面状态表示业务记录进度，不代表链上或银行付款已经执行。</div>{tab === "settlements" ? <Settlements /> : tab === "collections" ? <Collections /> : tab === "payouts" ? <Payouts /> : <AdjustmentRequest />}</>;
}

function Settlements() {
  const resource = useApiData<{ settlements: Settlement[] }>("/api/finance/settlements", "结算读取失败");
  return <FinancePanel title="结算记录" resource={resource} empty={!resource.data?.settlements.length}>{resource.data?.settlements.map((row) => <tr key={row.id}><td>{row.kind}<small>{row.id}</small></td><td>{row.periodStart} — {row.periodEnd}</td><td>{formatDecimal(row.amountUsdt)} USDT<small>{row.network}</small></td><td><StatusBadge value={row.status} /></td><td>{formatDateTime(row.createdAt)}</td></tr>)}</FinancePanel>;
}
function Collections() {
  const resource = useApiData<{ collections: Collection[] }>("/api/finance/collections", "应收读取失败");
  return <FinancePanel title="应收记录" resource={resource} empty={!resource.data?.collections.length}>{resource.data?.collections.map((row) => <tr key={row.id}><td>{row.email}<small>{row.customerId}</small></td><td>{formatDecimal(row.amountUsdt)} USDT</td><td>{formatDateTime(row.dueAt)}<small>宽限至 {formatDateTime(row.graceEndsAt)}</small></td><td><StatusBadge value={row.status} /></td><td>{row.remindersSent} 次提醒</td></tr>)}</FinancePanel>;
}
function Payouts() {
  const resource = useApiData<{ profiles: PayoutProfile[] }>("/api/finance/payout-profiles", "付款资料读取失败");
  return <FinancePanel title="付款资料" resource={resource} empty={!resource.data?.profiles.length}>{resource.data?.profiles.map((row) => <tr key={row.id}><td>{row.network}<small>{row.id}</small></td><td><small>{row.address}</small></td><td>{row.ownerOrganizationId}</td><td><StatusBadge value={row.status} /></td><td>{formatDateTime(row.createdAt)}</td></tr>)}</FinancePanel>;
}
function FinancePanel({ title, resource, empty, children }: { title: string; resource: { data: unknown; loading: boolean; error: string; refresh: () => Promise<void> }; empty: boolean; children: React.ReactNode }) {
  return <section className="rc-panel"><header><div><small>只读业务视图</small><h2>{title}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : empty ? <EmptyState title="没有记录" description="当前数据范围内没有财务记录。" /> : <div className="rc-table-wrap"><table><thead><tr><th>对象</th><th>期间 / 金额</th><th>详情</th><th>状态</th><th>时间 / 备注</th></tr></thead><tbody>{children}</tbody></table></div>}</section>;
}

function AdjustmentRequest() {
  const [form, setForm] = useState({ customerId: "", sourceId: "", amountUsdt: "", evidence: "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(reason: string) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/finance/adjustments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, amountUsdt: Number(form.amountUsdt), reason }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "调整申请失败"));
      setMessage("调整申请已进入双人审批；不可变账本尚未发生变化。");
      setOpen(false); setForm({ customerId: "", sourceId: "", amountUsdt: "", evidence: "" });
    } catch (error) { setMessage(error instanceof Error ? error.message : "调整申请失败"); }
    finally { setBusy(false); }
  }
  return <section className="rc-panel"><header><div><small>双人审批</small><h2>账务调整申请</h2></div></header><div className="rc-form"><label>客户 ID<input value={form.customerId} onChange={(event) => setForm({ ...form, customerId: event.target.value })} /></label><label>关联订单 / 来源 ID<input value={form.sourceId} onChange={(event) => setForm({ ...form, sourceId: event.target.value })} /></label><label>调整金额 USDT<input type="number" step="0.000001" value={form.amountUsdt} onChange={(event) => setForm({ ...form, amountUsdt: event.target.value })} /></label><label>证据摘要<textarea rows={3} value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} /></label><button className="rc-primary" type="button" onClick={() => setOpen(true)}>填写原因并提交</button></div><div className="rc-live" aria-live="polite">{message}</div><ConfirmActionDialog open={open} title="提交账务调整申请" description="申请需要双人审批，提交或批准都不会修改既有账本分录。" confirmLabel="提交申请" busy={busy} onCancel={() => setOpen(false)} onConfirm={(reason) => void submit(reason)} /></section>;
}
