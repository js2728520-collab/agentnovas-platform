"use client";

import { useEffect, useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime, formatDecimal, type OperationsCustomer } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type CustomerAction = "edit" | "freeze" | "restore" | "archive";

type CustomerDetail = {
  customer: OperationsCustomer & { updatedAt: string; archivedAt: string | null };
  attribution: { id: string; organizationName: string | null; managerEmail: string | null; supervisorEmail: string | null; employeeEmail: string | null; effectiveAt: string | null } | null;
  membership: { planCode: string; status: string; startsAt: string | null; expiresAt: string | null; graceEndsAt: string | null } | null;
  credits: { available: string; reserved: string; version: string; updatedAt: string } | null;
  creditLedger: { entryType: string; availableDelta: string; reservedDelta: string; balanceAvailable: string; balanceReserved: string; sourceType: string; sourceId: string; createdAt: string }[];
  portfolios: { id: string; strategyCode: string; principalUsdt: string; cashUsdt: string; realizedNetPnlUsdt: string; feesUsdt: string; accessStatus: string; openPositions: number; updatedAt: string }[];
  membershipOrders: { id: string; orderNo: string; planCode: string; status: string; priceAmount: string; priceCurrency: string; createdAt: string }[];
  performanceStatements: { id: string; weekStart: string; weekEnd: string; status: string; weekNetPnl: string; feeAmount: string; paymentStatus: string | null; createdAt: string }[];
  notes: { id: string; content: string; createdAt: string; authorUserId: string; authorEmail: string | null }[];
  assignmentCandidates: { id: string; email: string | null; role: "manager" | "supervisor" | "employee"; reportsToUserId: string | null }[];
  capabilities: { canManage: boolean; canTransfer: boolean; canAdjustCredits: boolean };
};

export function CustomersWorkspace() {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<OperationsCustomer | null>(null);
  const [pendingAction, setPendingAction] = useState<CustomerAction | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [newNote, setNewNote] = useState("");
  const [transfer, setTransfer] = useState({ managerId: "", supervisorId: "", employeeId: "", effectiveAt: "" });
  const [transferConfirming, setTransferConfirming] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialQuery = params.get("query") ?? "";
    setQuery(initialQuery); setAppliedQuery(initialQuery); setCursor(params.get("cursor") ?? ""); setReady(true);
  }, []);
  const resourceUrl = useMemo(() => {
    if (!ready) return null;
    const params = new URLSearchParams({ limit: "50" });
    if (appliedQuery) params.set("query", appliedQuery);
    if (cursor) params.set("cursor", cursor);
    return `/api/operations/customers?${params}`;
  }, [appliedQuery, cursor, ready]);
  const resource = useApiData<{ customers: OperationsCustomer[]; total: string; canManage: boolean; page: { nextCursor: string | null; hasMore: boolean } }>(resourceUrl, "客户读取失败");
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams();
    if (appliedQuery) params.set("query", appliedQuery);
    if (cursor) params.set("cursor", cursor);
    window.history.replaceState(null, "", `/customers${params.size ? `?${params}` : ""}`);
  }, [appliedQuery, cursor, ready]);
  const detail = useApiData<CustomerDetail>(selected ? `/api/operations/customers/${selected.customerId}` : null, "客户详情读取失败");
  const customers = resource.data?.customers ?? [];

  function choose(customer: OperationsCustomer) {
    setSelected(customer);
    setDisplayName(customer.displayName ?? "");
    setContactNote(customer.contactNote ?? "");
    setMessage("");
  }
  async function submit(reason: string) {
    if (!selected || !pendingAction) return;
    setBusy(true);
    setMessage("");
    try {
      const endpoint = pendingAction === "edit" ? "/api/organization/customers" : `/api/operations/customers/${selected.customerId}/status`;
      const response = await fetch(endpoint, {
        method: pendingAction === "edit" ? "PATCH" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(pendingAction === "edit" ? { customerId: selected.customerId, action: pendingAction, displayName, contactNote, reason } : { action: pendingAction, reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "客户操作失败"));
      setPendingAction(null);
      setMessage(typeof payload.message === "string" ? payload.message : "客户操作已记录");
      await resource.refresh();
      await detail.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "客户操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!selected || busy || !newNote.trim()) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/operations/customers/${selected.customerId}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: newNote }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "客户备注保存失败"));
      setNewNote(""); setMessage("客户备注已保存并记录审计。"); await detail.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "客户备注保存失败"); }
    finally { setBusy(false); }
  }

  async function submitTransfer(reason: string) {
    if (!selected || busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/operations/attribution-changes", {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ customerId: selected.customerId, ...transfer, reason, effectiveAt: transfer.effectiveAt ? new Date(transfer.effectiveAt).toISOString() : new Date().toISOString() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "客户归属调整提交失败"));
      setMessage("客户归属调整已提交复核；当前归属尚未改变。"); setTransferConfirming(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "客户归属调整提交失败"); }
    finally { setBusy(false); }
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取客户…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  return <>
    <PageHeading eyebrow="CUSTOMER OPERATIONS" title="客户管理" description="客户查看与管理权限分离，列表仅包含当前 RBAC 数据范围。" />
    <section className="rc-panel">
      <header><div><small>{resource.data?.total ?? 0} 位客户</small><h2>客户目录</h2></div><form className="rc-search" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); setCursor(""); setSelected(null); }}><label><span>搜索客户</span><input maxLength={120} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="邮箱、名称或客户 ID" /></label><button className="rc-button" type="submit">查询</button></form></header>
      {!customers.length ? <EmptyState title="没有匹配客户" description="调整搜索条件，或确认当前账户的数据范围。" /> : <div className="rc-table-wrap"><table><thead><tr><th>客户</th><th>状态</th><th>归属</th><th>注册时间</th><th>操作</th></tr></thead><tbody>
        {customers.map((customer) => <tr key={customer.customerId}><td><b>{customer.displayName || "未命名客户"}</b><small>{customer.email}</small><small>{customer.customerId}</small></td><td><StatusBadge value={customer.status} /></td><td><small>员工 {customer.employeeId || "—"}</small><small>分支 {customer.branchId || "—"}</small></td><td>{formatDateTime(customer.registeredAt)}</td><td><button className="rc-button" type="button" onClick={() => choose(customer)}>查看</button></td></tr>)}
      </tbody></table></div>}
      {resource.data?.page.hasMore ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => { setCursor(resource.data?.page.nextCursor ?? ""); setSelected(null); }}>下一页</button></div> : null}
    </section>
    {selected && <section className="rc-panel rc-detail-panel">
      <header><div><small>{selected.customerId}</small><h2>{selected.displayName || selected.email}</h2></div><button className="rc-button" type="button" onClick={() => setSelected(null)}>关闭</button></header>
      <div className="rc-form rc-form-grid">
        <label>展示名称<input disabled={!resource.data?.canManage} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>联系备注<textarea disabled={!resource.data?.canManage} rows={3} value={contactNote} onChange={(event) => setContactNote(event.target.value)} /></label>
      </div>
      {resource.data?.canManage ? <div className="rc-action-row">
        <button className="rc-button" type="button" onClick={() => setPendingAction("edit")}>保存资料</button>
        {(detail.data?.customer.status ?? selected.status) === "active" ? <button className="rc-button" type="button" onClick={() => setPendingAction("freeze")}>冻结客户</button> : <button className="rc-button" type="button" onClick={() => setPendingAction("restore")}>恢复客户</button>}
        {(detail.data?.customer.status ?? selected.status) !== "closed" ? <button className="rc-button rc-danger-button" type="button" onClick={() => setPendingAction("archive")}>归档客户</button> : null}
      </div> : <p className="rc-muted">当前权限仅允许查看客户。</p>}
      <div className="rc-live" aria-live="polite">{message}</div>
    </section>}
    {selected && (detail.loading && !detail.data ? <LoadingState label="正在汇总客户商业状态…" /> : detail.error && !detail.data ? <ErrorState message={detail.error} retry={detail.refresh} /> : detail.data ? <>
      <section className="rc-panel"><header><div><small>COMMERCIAL ACCESS</small><h2>会员与 Credits</h2></div></header><div className="rc-card-grid">
        <article className="rc-card"><header><StatusBadge value={detail.data.membership?.status ?? "未开通"} /></header><h3>{detail.data.membership?.planCode ?? "无会员"}</h3><p>到期：{formatDateTime(detail.data.membership?.expiresAt)}</p></article>
        <article className="rc-card"><header><StatusBadge value={detail.data.credits ? "已开立" : "未开立"} /></header><h3>{formatDecimal(detail.data.credits?.available ?? "0", 0)} Credits</h3><p>冻结 {formatDecimal(detail.data.credits?.reserved ?? "0", 0)} · 版本 {detail.data.credits?.version ?? "—"}</p></article>
        <article className="rc-card"><header><StatusBadge value={detail.data.attribution ? "已归属" : "未归属"} /></header><h3>{detail.data.attribution?.organizationName ?? "无组织"}</h3><p>经理 {detail.data.attribution?.managerEmail ?? "—"} · 员工 {detail.data.attribution?.employeeEmail ?? "—"}</p></article>
      </div></section>
      {detail.data.capabilities.canTransfer ? <section className="rc-panel"><header><div><small>MAKER / CHECKER</small><h2>客户归属调整</h2></div><StatusBadge value="提交后待复核" /></header><div className="rc-form rc-form-grid">
        <label>目标经理<select value={transfer.managerId} onChange={(event) => setTransfer({ managerId: event.target.value, supervisorId: "", employeeId: "", effectiveAt: transfer.effectiveAt })}><option value="">请选择经理</option>{detail.data.assignmentCandidates.filter((candidate) => candidate.role === "manager").map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.email ?? candidate.id}</option>)}</select></label>
        <label>目标主管（可选）<select value={transfer.supervisorId} disabled={!transfer.managerId} onChange={(event) => setTransfer((current) => ({ ...current, supervisorId: event.target.value, employeeId: "" }))}><option value="">不指定主管</option>{detail.data.assignmentCandidates.filter((candidate) => candidate.role === "supervisor" && candidate.reportsToUserId === transfer.managerId).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.email ?? candidate.id}</option>)}</select></label>
        <label>目标员工（可选）<select value={transfer.employeeId} disabled={!transfer.supervisorId} onChange={(event) => setTransfer((current) => ({ ...current, employeeId: event.target.value }))}><option value="">不指定员工</option>{detail.data.assignmentCandidates.filter((candidate) => candidate.role === "employee" && candidate.reportsToUserId === transfer.supervisorId).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.email ?? candidate.id}</option>)}</select></label>
        <label>生效时间<input type="datetime-local" value={transfer.effectiveAt} onChange={(event) => setTransfer((current) => ({ ...current, effectiveAt: event.target.value }))} /></label>
        <p className="rc-wide-field">目标成员必须属于当前组织并符合经理 → 主管 → 员工汇报链；复核通过前不会修改客户归属。</p>
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !transfer.managerId} onClick={() => setTransferConfirming(true)}>提交归属调整</button></div>
      </div></section> : null}
      <section className="rc-panel"><header><div><small>PAPER PORTFOLIOS</small><h2>模拟组合</h2></div></header>{!detail.data.portfolios.length ? <EmptyState title="尚无模拟组合" description="会员激活后会按官方策略开立独立组合。" /> : <div className="rc-table-wrap"><table><thead><tr><th>策略</th><th>访问</th><th>现金 / 本金</th><th>已实现净损益</th><th>持仓</th></tr></thead><tbody>{detail.data.portfolios.map((portfolio) => <tr key={portfolio.id}><td><b>{portfolio.strategyCode}</b><small>{portfolio.id}</small></td><td><StatusBadge value={portfolio.accessStatus} /></td><td>{formatDecimal(portfolio.cashUsdt)} / {formatDecimal(portfolio.principalUsdt)} USDT</td><td>{formatDecimal(portfolio.realizedNetPnlUsdt)} USDT<small>费用 {formatDecimal(portfolio.feesUsdt)}</small></td><td>{portfolio.openPositions}</td></tr>)}</tbody></table></div>}</section>
      <section className="rc-panel"><header><div><small>HANDOVER LOG</small><h2>备注历史</h2></div></header>{detail.data.capabilities.canManage ? <div className="rc-form"><label>新增备注<textarea rows={3} maxLength={2000} value={newNote} onChange={(event) => setNewNote(event.target.value)} /></label><div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy || !newNote.trim()} onClick={() => void addNote()}>保存备注</button></div></div> : null}{!detail.data.notes.length ? <EmptyState title="暂无备注" description="客户交接与服务记录会按时间保留。" /> : <div className="rc-timeline">{detail.data.notes.map((note) => <article key={note.id}><header><b>{note.authorEmail ?? note.authorUserId}</b><time>{formatDateTime(note.createdAt)}</time></header><p>{note.content}</p></article>)}</div>}</section>
      <section className="rc-panel"><header><div><small>COMMERCIAL HISTORY</small><h2>订单与周分成</h2></div></header><div className="rc-card-grid"><article className="rc-card"><h3>最近会员订单</h3>{detail.data.membershipOrders.length ? detail.data.membershipOrders.map((order) => <p key={order.id}><b>{order.orderNo}</b> · {order.planCode} · {formatDecimal(order.priceAmount)} {order.priceCurrency} · {order.status}</p>) : <p>暂无订单</p>}</article><article className="rc-card"><h3>最近绩效账单</h3>{detail.data.performanceStatements.length ? detail.data.performanceStatements.map((statement) => <p key={statement.id}><b>{formatDateTime(statement.weekStart)}</b> · 服务费 {formatDecimal(statement.feeAmount)} USDT · {statement.paymentStatus ?? statement.status}</p>) : <p>暂无账单</p>}</article></div></section>
    </> : null) }
    <ConfirmActionDialog open={Boolean(pendingAction)} title="确认客户操作" description={`操作将被审计：${pendingAction ?? ""}。请确认目标客户和业务依据。`} confirmLabel="确认并记录" busy={busy} onCancel={() => setPendingAction(null)} onConfirm={(reason) => void submit(reason)} />
    <ConfirmActionDialog open={transferConfirming} title="提交客户归属调整" description="申请只进入复核队列；另一名有权限的运营人员批准后才会生效。" confirmLabel="确认提交" busy={busy} onCancel={() => setTransferConfirming(false)} onConfirm={(reason) => void submitTransfer(reason)} />
  </>;
}
