"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime, type OperationsCustomer } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type CustomerAction = "edit" | "freeze" | "restore" | "archive";

export function CustomersWorkspace() {
  const resource = useApiData<{ customers: OperationsCustomer[]; total: number; canManage: boolean }>("/api/organization/customers", "客户读取失败");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<OperationsCustomer | null>(null);
  const [pendingAction, setPendingAction] = useState<CustomerAction | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const customers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return resource.data?.customers ?? [];
    return (resource.data?.customers ?? []).filter((customer) => [customer.email, customer.customerId, customer.displayName].some((value) => String(value ?? "").toLowerCase().includes(normalized)));
  }, [query, resource.data]);

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
      const response = await fetch("/api/organization/customers", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: selected.customerId, action: pendingAction, displayName, contactNote, reason }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "客户操作失败"));
      setPendingAction(null);
      setMessage(typeof payload.message === "string" ? payload.message : "客户操作已记录");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "客户操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取客户…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  return <>
    <PageHeading eyebrow="CUSTOMER OPERATIONS" title="客户管理" description="客户查看与管理权限分离，列表仅包含当前 RBAC 数据范围。" />
    <section className="rc-panel">
      <header><div><small>{resource.data?.total ?? 0} 位客户</small><h2>客户目录</h2></div><label className="rc-search"><span>搜索客户</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="邮箱、名称或客户 ID" /></label></header>
      {!customers.length ? <EmptyState title="没有匹配客户" description="调整搜索条件，或确认当前账户的数据范围。" /> : <div className="rc-table-wrap"><table><thead><tr><th>客户</th><th>状态</th><th>归属</th><th>注册时间</th><th>操作</th></tr></thead><tbody>
        {customers.map((customer) => <tr key={customer.customerId}><td><b>{customer.displayName || "未命名客户"}</b><small>{customer.email}</small><small>{customer.customerId}</small></td><td><StatusBadge value={customer.status} /></td><td><small>员工 {customer.employeeId || "—"}</small><small>分支 {customer.branchId || "—"}</small></td><td>{formatDateTime(customer.registeredAt)}</td><td><button className="rc-button" type="button" onClick={() => choose(customer)}>查看</button></td></tr>)}
      </tbody></table></div>}
    </section>
    {selected && <section className="rc-panel rc-detail-panel">
      <header><div><small>{selected.customerId}</small><h2>{selected.displayName || selected.email}</h2></div><button className="rc-button" type="button" onClick={() => setSelected(null)}>关闭</button></header>
      <div className="rc-form rc-form-grid">
        <label>展示名称<input disabled={!resource.data?.canManage} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>联系备注<textarea disabled={!resource.data?.canManage} rows={3} value={contactNote} onChange={(event) => setContactNote(event.target.value)} /></label>
      </div>
      {resource.data?.canManage ? <div className="rc-action-row">
        <button className="rc-button" type="button" onClick={() => setPendingAction("edit")}>保存资料</button>
        {selected.status === "frozen" ? <button className="rc-button" type="button" onClick={() => setPendingAction("restore")}>恢复客户</button> : <button className="rc-button" type="button" onClick={() => setPendingAction("freeze")}>冻结客户</button>}
        <button className="rc-button rc-danger-button" type="button" onClick={() => setPendingAction("archive")}>归档客户</button>
      </div> : <p className="rc-muted">当前权限仅允许查看客户。</p>}
      <div className="rc-live" aria-live="polite">{message}</div>
    </section>}
    <ConfirmActionDialog open={Boolean(pendingAction)} title="确认客户操作" description={`操作将被审计：${pendingAction ?? ""}。请确认目标客户和业务依据。`} confirmLabel="确认并记录" busy={busy} onCancel={() => setPendingAction(null)} onConfirm={(reason) => void submit(reason)} />
  </>;
}
