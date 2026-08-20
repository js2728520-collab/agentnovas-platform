"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime, formatDecimal, type AccessChangeRequest, type OperationsActionRequest } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type PendingDecision = { kind: "deposit" | "access"; id: string; decision: "approve" | "reject"; label: string };

export function ApprovalsWorkspace({ canApproveDeposits, canManageAccess }: { canApproveDeposits: boolean; canManageAccess: boolean }) {
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <>
    <PageHeading eyebrow="MAKER / CHECKER" title="审批中心" description="申请人与审批人必须分离；冲突和重复审批会保留服务端业务原因。" />
    <div className="rc-live" aria-live="polite">{message}</div>
    {canApproveDeposits ? <DepositApprovals onDecision={setPending} /> : <section className="rc-panel"><EmptyState title="无资金审批权限" description="当前账户不会看到充值人工操作队列。" /></section>}
    {canManageAccess ? <AccessApprovals onDecision={setPending} /> : <section className="rc-panel"><EmptyState title="无授权审批权限" description="当前账户不会看到角色变更队列。" /></section>}
    <ConfirmActionDialog open={Boolean(pending)} title={`${pending?.decision === "approve" ? "批准" : "拒绝"}${pending?.label ?? "申请"}`} description={pending?.kind === "deposit" ? "审批只会记录复核结果，不会自动修改资金或账本。" : "权限变更将由服务端按双人审批规则校验并应用。"} confirmLabel="确认审批" busy={busy} onCancel={() => setPending(null)} onConfirm={async (note) => {
      if (!pending) return;
      setBusy(true); setMessage("");
      try {
        const endpoint = pending.kind === "deposit" ? `/api/operations/deposit-action-requests/${pending.id}/decisions` : `/api/access/change-requests/${pending.id}/decisions`;
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: pending.decision, note }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, "审批失败"));
        setMessage(pending.kind === "deposit" ? "审批已记录；资金和账本尚未由此接口执行变更。" : "授权审批已记录，结果以服务端回执和审计记录为准。");
        setPending(null);
        window.dispatchEvent(new Event("riverton:approvals-changed"));
      } catch (error) { setMessage(error instanceof Error ? error.message : "审批失败"); }
      finally { setBusy(false); }
    }} />
  </>;
}

function DepositApprovals({ onDecision }: { onDecision: (decision: PendingDecision) => void }) {
  const resource = useApiData<{ actionRequests: OperationsActionRequest[] }>("/api/operations/deposit-action-requests?status=pending&limit=100", "资金审批队列读取失败");
  return <section className="rc-panel"><header><div><small>资金操作</small><h2>充值人工操作申请</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button></header>
    {resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.actionRequests.length ? <EmptyState title="没有待审批资金操作" description="队列中没有当前数据范围内的申请。" /> : <div className="rc-table-wrap"><table><thead><tr><th>订单</th><th>申请</th><th>金额</th><th>申请人</th><th>复核</th></tr></thead><tbody>{resource.data.actionRequests.map((item) => <tr key={item.id}><td><a className="rc-table-link" href={`/deposits/${item.depositOrderId}`}>{item.platformOrderNo}</a><small>{item.customerEmail || "—"}</small></td><td><b>{item.action}</b><small>{item.reason}</small><small>{formatDateTime(item.requestedAt)}</small></td><td>{formatDecimal(item.actualAmount)} {item.currency}</td><td><small>{item.requestedBy.email || item.requestedBy.userId}</small></td><td>{item.canReview ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => onDecision({ kind: "deposit", id: item.id, decision: "approve", label: item.action })}>批准</button><button className="rc-button rc-danger-button" type="button" onClick={() => onDecision({ kind: "deposit", id: item.id, decision: "reject", label: item.action })}>拒绝</button></div> : <StatusBadge value="禁止自审" />}</td></tr>)}</tbody></table></div>}
  </section>;
}

function AccessApprovals({ onDecision }: { onDecision: (decision: PendingDecision) => void }) {
  const resource = useApiData<{ changeRequests: AccessChangeRequest[] }>("/api/access/change-requests?status=pending&limit=100", "授权审批队列读取失败");
  return <section className="rc-panel"><header><div><small>敏感授权</small><h2>角色变更申请</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button></header>
    {resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.changeRequests.length ? <EmptyState title="没有待审批授权" description="当前应用没有等待复核的角色变更。" /> : <div className="rc-table-wrap"><table><thead><tr><th>类型</th><th>目标</th><th>申请人</th><th>状态</th><th>复核</th></tr></thead><tbody>{resource.data.changeRequests.map((item) => <tr key={item.id}><td><b>{item.changeType}</b><small>{item.reason}</small></td><td>{item.targetRoleName || item.targetUserEmail || "新建对象"}</td><td><small>{item.requestedBy.email || item.requestedBy.userId}</small><small>{formatDateTime(item.requestedAt)}</small></td><td><StatusBadge value={item.status} /></td><td>{item.canReview ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => onDecision({ kind: "access", id: item.id, decision: "approve", label: item.changeType })}>批准</button><button className="rc-button rc-danger-button" type="button" onClick={() => onDecision({ kind: "access", id: item.id, decision: "reject", label: item.changeType })}>拒绝</button></div> : <StatusBadge value="禁止自审" />}</td></tr>)}</tbody></table></div>}
  </section>;
}
