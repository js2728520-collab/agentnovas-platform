"use client";

import { useEffect, useMemo, useState } from "react";

import {
  apiErrorMessage,
  formatDateTime,
  formatDecimal,
  type OperationsCustomer,
  type OperationsCustomerPiiCategory,
} from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

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
  piiAccess: { available: OperationsCustomerPiiCategory[]; revealed: OperationsCustomerPiiCategory[] };
};

type CustomerListPayload = {
  customers: OperationsCustomer[];
  total: string;
  canManage: boolean;
  canExport: boolean;
  piiAccess: { available: OperationsCustomerPiiCategory[]; revealed: OperationsCustomerPiiCategory[] };
  page: { nextCursor: string | null; hasMore: boolean };
};

const PII_LABELS: Record<OperationsCustomerPiiCategory, string> = {
  contact: "完整联系方式",
  security: "登录 IP 与设备",
  financial: "累计充值与消费",
  trading: "交易所账户与持仓",
};

export function CustomersWorkspace() {
  const { locale, t } = useAppLocale();
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
  const [piiReason, setPiiReason] = useState("");
  const [piiCategories, setPiiCategories] = useState<OperationsCustomerPiiCategory[]>([]);
  const [piiMessage, setPiiMessage] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const initialQuery = params.get("query") ?? "";
      setQuery(initialQuery);
      setAppliedQuery(initialQuery);
      setCursor(params.get("cursor") ?? "");
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const resourceUrl = useMemo(() => {
    if (!ready) return null;
    const params = new URLSearchParams({ limit: "50" });
    if (appliedQuery) params.set("query", appliedQuery);
    if (cursor) params.set("cursor", cursor);
    return `/api/operations/customers?${params}`;
  }, [appliedQuery, cursor, ready]);
  const resource = useApiData<CustomerListPayload>(resourceUrl, t("客户读取失败"));
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams();
    if (appliedQuery) params.set("query", appliedQuery);
    if (cursor) params.set("cursor", cursor);
    window.history.replaceState(null, "", `/customers${params.size ? `?${params}` : ""}`);
  }, [appliedQuery, cursor, ready]);
  const detail = useApiData<CustomerDetail>(selected ? `/api/operations/customers/${selected.customerId}` : null, t("客户详情读取失败"));
  const customers = resource.data?.customers ?? [];

  function localizedApiError(payload: unknown, fallbackKey: string) {
    const fallback = t(fallbackKey);
    const detailMessage = apiErrorMessage(payload, fallback);
    return locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detailMessage) ? detailMessage : fallback;
  }

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
      if (!response.ok) throw new Error(localizedApiError(payload, "客户操作失败"));
      setPendingAction(null);
      setMessage(typeof payload.message === "string" && (locale === "zh-CN" || !/[\u3400-\u9fff]/.test(payload.message)) ? payload.message : t("客户操作已记录"));
      await resource.refresh();
      await detail.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("客户操作失败"));
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!selected || busy || !newNote.trim()) return;
    setBusy(true); setPiiMessage("");
    try {
      const response = await fetch(`/api/operations/customers/${selected.customerId}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: newNote }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(localizedApiError(payload, "客户备注保存失败"));
      setNewNote(""); setMessage(t("客户备注已保存并记录审计。")); await detail.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("客户备注保存失败")); }
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
      if (!response.ok) throw new Error(localizedApiError(payload, "客户归属调整提交失败"));
      setMessage(t("客户归属调整已提交复核；当前归属尚未改变。")); setTransferConfirming(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : t("客户归属调整提交失败")); }
    finally { setBusy(false); }
  }

  function piiHeaders(): Record<string, string> {
    return piiCategories.length ? { "x-customer-pii-reason": encodeURIComponent(piiReason.trim()) } : {};
  }

  function piiUrl(path: string) {
    const url = new URL(path, window.location.origin);
    if (piiCategories.length) url.searchParams.set("pii", piiCategories.join(","));
    return `${url.pathname}${url.search}`;
  }

  async function revealPii() {
    if (!resourceUrl || !piiCategories.length || busy) return;
    setBusy(true); setMessage("");
    try {
      const listResponse = await fetch(piiUrl(resourceUrl), { cache: "no-store", headers: piiHeaders() });
      const listPayload = await listResponse.json().catch(() => ({}));
      if (!listResponse.ok) throw new Error(localizedApiError(listPayload, "敏感字段读取失败"));
      resource.setData(listPayload as CustomerListPayload);
      if (selected) {
        const detailResponse = await fetch(piiUrl(`/api/operations/customers/${selected.customerId}`), { cache: "no-store", headers: piiHeaders() });
        const detailPayload = await detailResponse.json().catch(() => ({}));
        if (!detailResponse.ok) throw new Error(localizedApiError(detailPayload, "客户敏感详情读取失败"));
        detail.setData(detailPayload as CustomerDetail);
      }
      setPiiMessage(t("敏感字段已按所选分类临时展示，本次访问原因已记录审计。"));
    } catch (error) { setPiiMessage(error instanceof Error ? error.message : t("敏感字段读取失败")); }
    finally { setBusy(false); }
  }

  async function exportCustomers() {
    if (busy) return;
    setBusy(true); setPiiMessage("");
    try {
      const params = new URLSearchParams();
      if (appliedQuery) params.set("query", appliedQuery);
      if (piiCategories.length) params.set("pii", piiCategories.join(","));
      const response = await fetch(`/api/operations/customers/export?${params}`, { method: "POST", cache: "no-store", headers: piiHeaders() });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(localizedApiError(payload, "客户导出失败"));
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
      setPiiMessage(t("客户 CSV 已生成并下载；服务端未保留导出文件，生成与下载均已审计。"));
    } catch (error) { setPiiMessage(error instanceof Error ? error.message : t("客户导出失败")); }
    finally { setBusy(false); }
  }

  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取客户…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  return <>
    <PageHeading eyebrow="CUSTOMER OPERATIONS" title={t("客户管理")} description={t("客户查看与管理权限分离，列表仅包含当前 RBAC 数据范围。")} />
    <section className="rc-panel">
      <header><div><small>FIELD-LEVEL PII CONTROL</small><h2>{t("敏感字段临时访问与导出")}</h2></div><StatusBadge value={t(resource.data?.piiAccess.revealed.length ? "已临时展示" : "默认遮罩")} /></header>
      {!resource.data?.piiAccess.available.length ? <p className="rc-muted">{t("当前角色没有客户敏感字段权限；列表、详情和导出都会保持遮罩或省略。")}</p> : <div className="rc-form">
        <fieldset><legend>{t("选择本次需要访问的字段分类")}</legend><div className="rc-action-row">
          {resource.data.piiAccess.available.map((category) => <label key={category}><input type="checkbox" checked={piiCategories.includes(category)} onChange={(event) => setPiiCategories((current) => event.target.checked ? [...current, category] : current.filter((item) => item !== category))} /> {t(PII_LABELS[category])}</label>)}
        </div></fieldset>
        <label>{t("业务原因（访问敏感字段时必填，8–500 字）")}<textarea rows={2} maxLength={500} value={piiReason} onChange={(event) => setPiiReason(event.target.value)} placeholder={t("例如：处理客户授权的账户核对工单")} /></label>
        <div className="rc-action-row">
          <button className="rc-primary" type="button" disabled={busy || !piiCategories.length || piiReason.trim().length < 8} onClick={() => void revealPii()}>{t("临时展示所选字段")}</button>
          {resource.data.canExport ? <button className="rc-button" type="button" disabled={busy || (piiCategories.length > 0 && piiReason.trim().length < 8)} onClick={() => void exportCustomers()}>{t("导出当前筛选 CSV")}</button> : null}
        </div>
      </div>}
      <p className="rc-muted">{t("访问只对本次请求生效；原因会脱敏后进入审计。CSV 最多 5000 行，并对电子表格公式注入做转义。")}</p>
      <div className="rc-live" aria-live="polite">{piiMessage}</div>
    </section>
    <section className="rc-panel">
      <header><div><small>{resource.data?.total ?? 0} {t("位客户")}</small><h2>{t("客户目录")}</h2></div><form className="rc-search" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); setCursor(""); setSelected(null); }}><label><span>{t("搜索客户")}</span><input maxLength={120} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("邮箱、名称或客户 ID")} /></label><button className="rc-button" type="submit">{t("查询")}</button></form></header>
      {!customers.length ? <EmptyState title={t("没有匹配客户")} description={t("调整搜索条件，或确认当前账户的数据范围。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("客户")}</th><th>{t("状态")}</th><th>{t("归属")}</th><th>{t("注册时间")}</th><th>{t("操作")}</th></tr></thead><tbody>
        {customers.map((customer) => <tr key={customer.customerId}><td><b>{customer.displayName || t("未命名客户")}</b><small>{customer.email}</small><small>{customer.customerId}</small></td><td><StatusBadge value={customer.status} /></td><td><small>{t("员工")} {customer.employeeId || "—"}</small><small>{t("分支")} {customer.branchId || "—"}</small></td><td>{formatDateTime(customer.registeredAt, locale)}</td><td><button className="rc-button" type="button" onClick={() => choose(customer)}>{t("查看")}</button></td></tr>)}
      </tbody></table></div>}
      {resource.data?.page.hasMore ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => { setCursor(resource.data?.page.nextCursor ?? ""); setSelected(null); }}>{t("下一页")}</button></div> : null}
    </section>
    {selected && <section className="rc-panel rc-detail-panel">
      <header><div><small>{selected.customerId}</small><h2>{selected.displayName || selected.email}</h2></div><button className="rc-button" type="button" onClick={() => setSelected(null)}>{t("关闭")}</button></header>
      <div className="rc-form rc-form-grid">
        <label>{t("展示名称")}<input disabled={!resource.data?.canManage} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>{t("联系备注")}<textarea disabled={!resource.data?.canManage} rows={3} value={contactNote} onChange={(event) => setContactNote(event.target.value)} /></label>
      </div>
      {resource.data?.canManage ? <div className="rc-action-row">
        <button className="rc-button" type="button" onClick={() => setPendingAction("edit")}>{t("保存资料")}</button>
        {(detail.data?.customer.status ?? selected.status) === "active" ? <button className="rc-button" type="button" onClick={() => setPendingAction("freeze")}>{t("冻结客户")}</button> : <button className="rc-button" type="button" onClick={() => setPendingAction("restore")}>{t("恢复客户")}</button>}
        {(detail.data?.customer.status ?? selected.status) !== "closed" ? <button className="rc-button rc-danger-button" type="button" onClick={() => setPendingAction("archive")}>{t("归档客户")}</button> : null}
      </div> : <p className="rc-muted">{t("当前权限仅允许查看客户。")}</p>}
      <div className="rc-live" aria-live="polite">{message}</div>
    </section>}
    {selected && (detail.loading && !detail.data ? <LoadingState label={t("正在汇总客户商业状态…")} /> : detail.error && !detail.data ? <ErrorState message={detail.error} retry={detail.refresh} /> : detail.data ? <>
      <section className="rc-panel"><header><div><small>PROTECTED CUSTOMER DATA</small><h2>{t("受控客户字段")}</h2></div><StatusBadge value={t(detail.data.piiAccess.revealed.length ? "本次已授权" : "遮罩")} /></header><div className="rc-card-grid">
        <article className="rc-card"><h3>{t("联系方式")}</h3><p>{t("邮箱：")}{detail.data.customer.pii.contact.email ?? "—"}</p><p>{t("电话：")}{detail.data.customer.pii.contact.phone ?? "—"}</p><p>Telegram: {detail.data.customer.pii.contact.telegram ?? "—"}</p><p>WhatsApp: {detail.data.customer.pii.contact.whatsapp ?? "—"}</p></article>
        <article className="rc-card"><h3>{t("登录安全")}</h3><p>{t("注册网络：")}{detail.data.customer.pii.security.registrationIpAddress ?? "—"}</p><p>{t("最近登录网络：")}{detail.data.customer.pii.security.lastLoginIpAddress ?? "—"}</p><p>{t("设备：")}{detail.data.customer.pii.security.device ?? t("未授权展示")}</p></article>
        <article className="rc-card"><h3>{t("财务汇总")}</h3><p>{t("累计充值：")}{detail.data.customer.pii.financial.cumulativeDepositUsdt === null ? t("未授权展示") : `${formatDecimal(detail.data.customer.pii.financial.cumulativeDepositUsdt, 6, locale)} USDT`}</p><p>{t("累计消费：")}{detail.data.customer.pii.financial.cumulativeSpendUsdt === null ? t("未授权展示") : `${formatDecimal(detail.data.customer.pii.financial.cumulativeSpendUsdt, 6, locale)} USDT`}</p></article>
        <article className="rc-card"><h3>{t("交易账户")}</h3><p>{detail.data.customer.pii.trading.exchangeAccounts.length ? `${detail.data.customer.pii.trading.exchangeAccounts.length} ${t("个账户")} · ${detail.data.customer.pii.trading.openPositions.length} ${t("个持仓")}` : t("未授权展示或暂无数据")}</p>{detail.data.customer.pii.trading.exchangeAccounts.map((account) => <p key={account.id}><b>{account.exchange}</b> · {account.label} · {account.environment} · {account.status}</p>)}</article>
      </div></section>
      <section className="rc-panel"><header><div><small>COMMERCIAL ACCESS</small><h2>{t("会员与 Credits")}</h2></div></header><div className="rc-card-grid">
        <article className="rc-card"><header><StatusBadge value={detail.data.membership?.status ?? t("未开通")} /></header><h3>{detail.data.membership?.planCode ?? t("无会员")}</h3><p>{t("到期：")}{formatDateTime(detail.data.membership?.expiresAt, locale)}</p></article>
        <article className="rc-card"><header><StatusBadge value={t(detail.data.credits ? "已开立" : "未开立")} /></header><h3>{formatDecimal(detail.data.credits?.available ?? "0", 0, locale)} Credits</h3><p>{t("冻结")} {formatDecimal(detail.data.credits?.reserved ?? "0", 0, locale)} · {t("版本")} {detail.data.credits?.version ?? "—"}</p></article>
        <article className="rc-card"><header><StatusBadge value={t(detail.data.attribution ? "已归属" : "未归属")} /></header><h3>{detail.data.attribution?.organizationName ?? t("无组织")}</h3><p>{t("经理")} {detail.data.attribution?.managerEmail ?? "—"} · {t("员工")} {detail.data.attribution?.employeeEmail ?? "—"}</p></article>
      </div></section>
      {detail.data.capabilities.canTransfer ? <section className="rc-panel"><header><div><small>MAKER / CHECKER</small><h2>{t("客户归属调整")}</h2></div><StatusBadge value={t("提交后待复核")} /></header><div className="rc-form rc-form-grid">
        <label>{t("目标经理")}<select value={transfer.managerId} onChange={(event) => setTransfer({ managerId: event.target.value, supervisorId: "", employeeId: "", effectiveAt: transfer.effectiveAt })}><option value="">{t("请选择经理")}</option>{detail.data.assignmentCandidates.filter((candidate) => candidate.role === "manager").map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.email ?? candidate.id}</option>)}</select></label>
        <label>{t("目标主管（可选）")}<select value={transfer.supervisorId} disabled={!transfer.managerId} onChange={(event) => setTransfer((current) => ({ ...current, supervisorId: event.target.value, employeeId: "" }))}><option value="">{t("不指定主管")}</option>{detail.data.assignmentCandidates.filter((candidate) => candidate.role === "supervisor" && candidate.reportsToUserId === transfer.managerId).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.email ?? candidate.id}</option>)}</select></label>
        <label>{t("目标员工（可选）")}<select value={transfer.employeeId} disabled={!transfer.supervisorId} onChange={(event) => setTransfer((current) => ({ ...current, employeeId: event.target.value }))}><option value="">{t("不指定员工")}</option>{detail.data.assignmentCandidates.filter((candidate) => candidate.role === "employee" && candidate.reportsToUserId === transfer.supervisorId).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.email ?? candidate.id}</option>)}</select></label>
        <label>{t("生效时间")}<input type="datetime-local" value={transfer.effectiveAt} onChange={(event) => setTransfer((current) => ({ ...current, effectiveAt: event.target.value }))} /></label>
        <p className="rc-wide-field">{t("目标成员必须属于当前组织并符合经理 → 主管 → 员工汇报链；复核通过前不会修改客户归属。")}</p>
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !transfer.managerId} onClick={() => setTransferConfirming(true)}>{t("提交归属调整")}</button></div>
      </div></section> : null}
      <section className="rc-panel"><header><div><small>PAPER PORTFOLIOS</small><h2>{t("模拟组合")}</h2></div></header>{!detail.data.portfolios.length ? <EmptyState title={t("尚无模拟组合")} description={t("会员激活后会按官方策略开立独立组合。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("策略")}</th><th>{t("访问")}</th><th>{t("现金 / 本金")}</th><th>{t("已实现净损益")}</th><th>{t("持仓")}</th></tr></thead><tbody>{detail.data.portfolios.map((portfolio) => <tr key={portfolio.id}><td><b>{portfolio.strategyCode}</b><small>{portfolio.id}</small></td><td><StatusBadge value={portfolio.accessStatus} /></td><td>{formatDecimal(portfolio.cashUsdt, 6, locale)} / {formatDecimal(portfolio.principalUsdt, 6, locale)} USDT</td><td>{formatDecimal(portfolio.realizedNetPnlUsdt, 6, locale)} USDT<small>{t("费用")} {formatDecimal(portfolio.feesUsdt, 6, locale)}</small></td><td>{portfolio.openPositions}</td></tr>)}</tbody></table></div>}</section>
      <section className="rc-panel"><header><div><small>HANDOVER LOG</small><h2>{t("备注历史")}</h2></div></header>{detail.data.capabilities.canManage ? <div className="rc-form"><label>{t("新增备注")}<textarea rows={3} maxLength={2000} value={newNote} onChange={(event) => setNewNote(event.target.value)} /></label><div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy || !newNote.trim()} onClick={() => void addNote()}>{t("保存备注")}</button></div></div> : null}{!detail.data.notes.length ? <EmptyState title={t("暂无备注")} description={t("客户交接与服务记录会按时间保留。")} /> : <div className="rc-timeline">{detail.data.notes.map((note) => <article key={note.id}><header><b>{note.authorEmail ?? note.authorUserId}</b><time>{formatDateTime(note.createdAt, locale)}</time></header><p>{note.content}</p></article>)}</div>}</section>
      <section className="rc-panel"><header><div><small>COMMERCIAL HISTORY</small><h2>{t("订单与周分成")}</h2></div></header><div className="rc-card-grid"><article className="rc-card"><h3>{t("最近会员订单")}</h3>{detail.data.membershipOrders.length ? detail.data.membershipOrders.map((order) => <p key={order.id}><b>{order.orderNo}</b> · {order.planCode} · {formatDecimal(order.priceAmount, 6, locale)} {order.priceCurrency} · {order.status}</p>) : <p>{t("暂无订单")}</p>}</article><article className="rc-card"><h3>{t("最近绩效账单")}</h3>{detail.data.performanceStatements.length ? detail.data.performanceStatements.map((statement) => <p key={statement.id}><b>{formatDateTime(statement.weekStart, locale)}</b> · {t("服务费")} {formatDecimal(statement.feeAmount, 6, locale)} USDT · {statement.paymentStatus ?? statement.status}</p>) : <p>{t("暂无账单")}</p>}</article></div></section>
    </> : null) }
    <ConfirmActionDialog open={Boolean(pendingAction)} title={t("确认客户操作")} description={`${t("操作将被审计：")}${pendingAction ?? ""}${t("。请确认目标客户和业务依据。")}`} confirmLabel={t("确认并记录")} busy={busy} onCancel={() => setPendingAction(null)} onConfirm={(reason) => void submit(reason)} />
    <ConfirmActionDialog open={transferConfirming} title={t("提交客户归属调整")} description={t("申请只进入复核队列；另一名有权限的运营人员批准后才会生效。")} confirmLabel={t("确认提交")} busy={busy} onCancel={() => setTransferConfirming(false)} onConfirm={(reason) => void submitTransfer(reason)} />
  </>;
}
