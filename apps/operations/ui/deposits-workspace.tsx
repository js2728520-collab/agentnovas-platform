"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { apiErrorMessage, formatDateTime, formatDecimal, type OperationsDeposit, type OperationsDepositDetail } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

const manualActions = ["APPROVE_CREDIT", "REJECT_DEPOSIT", "MANUAL_RECORD", "FREEZE_FUNDS", "UNFREEZE_FUNDS", "REQUEST_RETURN", "CONFIRM_RETURN"];

export function DepositsWorkspace({ depositId, canRequestAction }: { depositId?: string; canRequestAction: boolean }) {
  return depositId ? <DepositDetail depositId={depositId} canRequestAction={canRequestAction} /> : <DepositList />;
}

function DepositList() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const url = useMemo(() => {
    const params = new URLSearchParams({ limit: "100" });
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    return `/api/operations/deposits?${params}`;
  }, [query, status]);
  const resource = useApiData<{ deposits: OperationsDeposit[] }>(url, "充值订单读取失败");
  return <>
    <PageHeading eyebrow="DEPOSIT OPERATIONS" title="充值订单" description="列表和详情执行一致的 PII 脱敏与数据范围控制。" />
    <section className="rc-panel">
      <header><div><small>只展示真实订单</small><h2>充值查询</h2></div><div className="rc-filter-row"><label><span>搜索</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="订单号、交易哈希或客户" /></label><label><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部</option><option>PENDING_CONFIRMATION</option><option>CONFIRMING</option><option>MANUAL_REVIEW</option><option>CREDITED</option><option>FAILED</option><option>RETURNED</option></select></label></div></header>
      {resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.deposits.length ? <EmptyState title="没有充值订单" description="当前筛选和数据范围内没有订单。" /> : <div className="rc-table-wrap"><table><thead><tr><th>订单</th><th>客户</th><th>金额</th><th>状态</th><th>确认</th><th>创建时间</th></tr></thead><tbody>
        {resource.data.deposits.map((deposit) => <tr key={deposit.id}><td><a className="rc-table-link" href={`/deposits/${deposit.id}`}>{deposit.platformOrderNo}</a><small>{deposit.txId || "尚无交易哈希"}</small></td><td><b>{deposit.user.nickname || "客户"}</b><small>{deposit.user.email || "—"}</small></td><td><b>{formatDecimal(deposit.actualAmount ?? deposit.expectedAmount)} {deposit.currency}</b><small>{deposit.channel} · {deposit.network || "—"}</small></td><td><StatusBadge value={deposit.orderStatus} /><small>{deposit.fundsStatus} · {deposit.riskStatus}</small></td><td>{deposit.confirmations}/{deposit.requiredConfirmations ?? "—"}</td><td>{formatDateTime(deposit.createdAt)}</td></tr>)}
      </tbody></table></div>}
    </section>
  </>;
}

type DetailAction = { id: string; action: string; status: string; reason: string; requestedByUserId: string; requestedAt: string; completedAt: string | null; decisions: unknown[] };

function DepositDetail({ depositId, canRequestAction }: { depositId: string; canRequestAction: boolean }) {
  const resource = useApiData<{ deposit: OperationsDepositDetail; actionRequests: DetailAction[]; piiRevealed: boolean }>(`/api/operations/deposits/${encodeURIComponent(depositId)}`, "充值详情读取失败");
  const [action, setAction] = useState(manualActions[0]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(reason: string) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/operations/deposits/${encodeURIComponent(depositId)}/action-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, reason, payload: {} }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "人工操作申请失败"));
      setConfirmOpen(false);
      setMessage("人工操作申请已提交，等待第二人审批；资金和账本尚未执行任何变更。");
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "人工操作申请失败"); }
    finally { setBusy(false); }
  }
  if (resource.loading && !resource.data) return <LoadingState label="正在读取充值详情…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return null;
  const deposit = resource.data.deposit;
  return <>
    <PageHeading eyebrow="DEPOSIT DETAIL" title={deposit.platformOrderNo} description="优盾验签回调进入人工复核；仅 APPROVE_CREDIT 的第二人批准会原子写入钱包与不可变账本。" actions={<Link className="rc-button" href="/deposits">返回列表</Link>} />
    <div className="rc-kpi-grid"><article><small>订单状态</small><strong className="rc-kpi-status"><StatusBadge value={deposit.orderStatus} /></strong><span>{deposit.fundsStatus}</span></article><article><small>实际金额</small><strong>{formatDecimal(deposit.actualAmount)} </strong><span>{deposit.currency}</span></article><article><small>链上确认</small><strong>{deposit.confirmations}</strong><span>需要 {deposit.requiredConfirmations ?? "—"} 次</span></article><article><small>隐私字段</small><strong className="rc-kpi-status">{resource.data.piiRevealed ? "已授权" : "已脱敏"}</strong><span>由 ops.deposits.pii_reveal 控制</span></article></div>
    <section className="rc-panel"><header><div><small>{deposit.channel} · {deposit.network || "—"}</small><h2>订单与客户</h2></div><StatusBadge value={deposit.riskStatus} /></header><dl className="rc-description-list"><div><dt>客户</dt><dd>{deposit.user.nickname || "客户"} · {deposit.user.email}</dd></div><div><dt>来源地址</dt><dd>{deposit.sourceAddress || "—"}</dd></div><div><dt>入账地址</dt><dd>{deposit.depositAddress || "—"}</dd></div><div><dt>交易哈希</dt><dd>{deposit.txId || "—"}</dd></div><div><dt>账本事务</dt><dd>{deposit.ledgerTransactionId || "尚未关联"}</dd></div><div><dt>更新时间</dt><dd>{formatDateTime(deposit.updatedAt)}</dd></div></dl></section>
    {canRequestAction && <section className="rc-panel"><header><div><small>MAKER</small><h2>发起人工操作</h2></div></header><div className="rc-action-row"><label><span>操作类型</span><select value={action} onChange={(event) => setAction(event.target.value)}>{manualActions.map((value) => <option key={value}>{value}</option>)}</select></label><button className="rc-button" type="button" onClick={() => setConfirmOpen(true)}>填写原因并提交</button></div><p className="rc-muted">提交只进入审批队列；APPROVE_CREDIT 必须由另一位 checker 批准后才会原子入账。</p></section>}
    <section className="rc-panel"><header><div><small>审批记录</small><h2>人工操作历史</h2></div></header>{!resource.data.actionRequests.length ? <EmptyState title="没有人工操作" description="此订单尚无人工操作申请。" /> : <div className="rc-table-wrap"><table><thead><tr><th>操作</th><th>状态</th><th>原因</th><th>申请时间</th></tr></thead><tbody>{resource.data.actionRequests.map((item) => <tr key={item.id}><td>{item.action}</td><td><StatusBadge value={item.status} /></td><td>{item.reason}</td><td>{formatDateTime(item.requestedAt)}</td></tr>)}</tbody></table></div>}</section>
    <div className="rc-live" aria-live="polite">{message}</div>
    <ConfirmActionDialog open={confirmOpen} title={`提交 ${action}`} description="此操作必须由另一位有权限的运营人员审批。提交后不会自动改变资金或账本。" confirmLabel="提交审批申请" busy={busy} onCancel={() => setConfirmOpen(false)} onConfirm={(reason) => void submit(reason)} />
  </>;
}
