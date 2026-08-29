"use client";

import { useState } from "react";
import Link from "next/link";

import { apiErrorMessage, formatDateTime, formatDecimal, type AccessChangeRequest, type OperationsActionRequest } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type PendingDecision = { kind: "deposit" | "access" | "credit" | "attribution" | "reporting"; id: string; decision: "approve" | "reject"; label: string };
type CursorPage<T> = { data: T[]; page: { nextCursor: string | null; hasMore: boolean } };
type CommercialQueueItem = { id: string; customerId: string; status: string; createdAt: string; orderNo?: string; cycleStartedAt?: string; cycleEndedAt?: string; feeAmount?: string };
type ReportingRequest = { id: string; subjectId: string; requestedBy: string; requestedAt: string; reason: string; newReportsToUserId: string | null; approvals: number; required: number; canReview: boolean };

export function ApprovalsWorkspace({ canApproveDeposits, canManageAccess, canApproveCredits, canManageAttributions, canApproveMembership, canApprovePerformance, canReviewOrganization }: { canApproveDeposits: boolean; canManageAccess: boolean; canApproveCredits: boolean; canManageAttributions: boolean; canApproveMembership: boolean; canApprovePerformance: boolean; canReviewOrganization: boolean }) {
  const { locale, t } = useAppLocale();
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  return <>
    <PageHeading eyebrow="MAKER / CHECKER" title={t("审批中心")} description={t("申请人与审批人必须分离；冲突和重复审批会保留服务端业务原因。")} />
    <div className="rc-live" aria-live="polite">{message}</div>
    {canApproveMembership ? <MembershipApprovals key={`membership-${refreshVersion}`} /> : null}
    {canApprovePerformance ? <PerformanceApprovals key={`performance-${refreshVersion}`} /> : null}
    {canApproveDeposits ? <DepositApprovals key={`deposit-${refreshVersion}`} onDecision={setPending} /> : <section className="rc-panel"><EmptyState title={t("无资金审批权限")} description={t("当前账户不会看到充值人工操作队列。")} /></section>}
    {canApproveCredits ? <CreditApprovals key={`credit-${refreshVersion}`} onDecision={setPending} /> : null}
    {canManageAttributions ? <AttributionApprovals key={`attribution-${refreshVersion}`} onDecision={setPending} /> : null}
    {canReviewOrganization ? <ReportingApprovals key={`reporting-${refreshVersion}`} onDecision={setPending} /> : null}
    {canManageAccess ? <AccessApprovals key={`access-${refreshVersion}`} onDecision={setPending} /> : <section className="rc-panel"><EmptyState title={t("无授权审批权限")} description={t("当前账户不会看到角色变更队列。")} /></section>}
    <ConfirmActionDialog open={Boolean(pending)} title={`${pending?.decision === "approve" ? t("批准") : t("拒绝")}${pending?.label ?? t("申请")}`} description={pending?.kind === "deposit" ? pending.label === "APPROVE_CREDIT" && pending.decision === "approve" ? t("批准会在同一数据库事务写入不可变账本、钱包余额和审计；任何校验失败都会整体回滚。") : t("决定会记录到审批历史；非入账操作不会由此接口改变钱包余额。") : pending?.kind === "credit" ? t("批准会在同一事务写入余额、不可变 Credits 分录和审计；拒绝不会改变余额。") : pending?.kind === "attribution" ? t("批准会原子更新客户归属；如原归属已变化，服务端会拒绝旧快照。") : pending?.kind === "reporting" ? t("申请人与复核人必须不同；批准前会再次校验当前汇报关系快照。") : t("权限变更将由服务端按双人审批规则校验并应用。")} confirmLabel={t("确认审批")} busy={busy} onCancel={() => setPending(null)} onConfirm={async (note) => {
      if (!pending) return;
      setBusy(true); setMessage("");
      try {
        const endpoint = pending.kind === "deposit" ? `/api/operations/deposit-action-requests/${pending.id}/decisions`
          : pending.kind === "access" ? `/api/access/change-requests/${pending.id}/decisions`
            : pending.kind === "credit" ? `/api/operations/credit-adjustments/${pending.id}/decision`
              : pending.kind === "attribution" ? `/api/operations/attribution-changes/${pending.id}/decision`
                : `/api/approvals/${pending.id}/decision`;
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...(pending.kind === "credit" || pending.kind === "attribution" || pending.kind === "deposit" ? { "idempotency-key": crypto.randomUUID() } : {}) }, body: JSON.stringify({ decision: pending.decision, note }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const fallback = t("审批失败");
          const detail = apiErrorMessage(payload, fallback);
          throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
        }
        const depositFallback = payload.fundsExecuted ? t("充值已通过不可变账本入账。") : t("审批记录已保存，未执行资金变更。");
        const depositMessage = typeof payload.message === "string" && (locale === "zh-CN" || !/[\u3400-\u9fff]/.test(payload.message)) ? payload.message : depositFallback;
        setMessage(pending.kind === "deposit" ? depositMessage : pending.kind === "credit" ? t("Credits 复核已记录；批准时余额与不可变分录在同一事务写入。") : pending.kind === "attribution" ? t("客户归属复核已记录；批准时组织归属原子生效。") : pending.kind === "reporting" ? t("汇报关系复核已记录；服务端快照有效时关系已原子生效。") : t("授权审批已记录，结果以服务端回执和审计记录为准。"));
        setPending(null);
        setRefreshVersion((version) => version + 1);
        window.dispatchEvent(new Event("riverton:approvals-changed"));
      } catch (error) { setMessage(error instanceof Error ? error.message : t("审批失败")); }
      finally { setBusy(false); }
    }} />
  </>;
}

function MembershipApprovals() {
  const { t } = useAppLocale();
  const resource = useApiData<CursorPage<CommercialQueueItem>>("/api/operations/membership-orders?status=SUBMITTED&limit=100", t("会员审批队列读取失败"));
  return <CommercialApprovalPanel
    eyebrow="MEMBERSHIP"
    title={t("会员订单复核")}
    emptyTitle={t("没有待复核会员订单")}
    resource={resource}
    href={(item) => `/membership-orders/${encodeURIComponent(item.id)}`}
    label={(item) => item.orderNo ?? item.id}
    detail={(item) => `${t("客户")} ${item.customerId}`}
  />;
}

function PerformanceApprovals() {
  const { locale, t } = useAppLocale();
  const assessment = useApiData<CursorPage<CommercialQueueItem>>("/api/operations/performance-statements?status=SUBMITTED&limit=100", t("周分成审批队列读取失败"));
  const payment = useApiData<CursorPage<CommercialQueueItem>>("/api/operations/performance-statements?status=INVOICED&limit=100", t("周分成付款复核队列读取失败"));
  return <>
    <CommercialApprovalPanel eyebrow="PAPER FEE" title={t("周分成业务复核")} emptyTitle={t("没有待复核周分成")} resource={assessment} href={(item) => `/performance-statements/${encodeURIComponent(item.id)}`} label={(item) => `${formatDateTime(item.cycleStartedAt ?? item.createdAt, locale)} ${t("周期")}`} detail={(item) => `${t("客户")} ${item.customerId} · ${formatDecimal(item.feeAmount ?? "0")} USDT`} />
    <CommercialApprovalPanel eyebrow="PAYMENT EVIDENCE" title={t("周分成付款凭证复核")} emptyTitle={t("没有待复核付款凭证")} resource={payment} href={(item) => `/performance-statements/${encodeURIComponent(item.id)}`} label={(item) => `${formatDateTime(item.cycleEndedAt ?? item.createdAt, locale)} ${t("到期")}`} detail={(item) => `${t("客户")} ${item.customerId} · ${t("仅确认外部凭证")}`} />
  </>;
}

function CommercialApprovalPanel({ eyebrow, title, emptyTitle, resource, href, label, detail }: {
  eyebrow: string;
  title: string;
  emptyTitle: string;
  resource: { data: CursorPage<CommercialQueueItem> | null; loading: boolean; error: string; refresh: () => Promise<void> };
  href: (item: CommercialQueueItem) => string;
  label: (item: CommercialQueueItem) => string;
  detail: (item: CommercialQueueItem) => string;
}) {
  const { t } = useAppLocale();
  return <section className="rc-panel"><header><div><small>{eyebrow}</small><h2>{title}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.data.length ? <EmptyState title={emptyTitle} description={t("当前数据范围内没有待处理记录。")} /> : <div className="rc-card-list">{resource.data.data.map((item) => <article key={item.id}><header><div><b>{label(item)}</b><small>{detail(item)}</small></div><StatusBadge value={item.status} /></header><div className="rc-action-row"><Link className="rc-button" href={href(item)}>{t("进入详情复核")}</Link><span className="rc-muted">{t("详情页会隐藏自审操作")}</span></div></article>)}</div>}</section>;
}

function ReportingApprovals({ onDecision }: { onDecision: (decision: PendingDecision) => void }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ requests: ReportingRequest[] }>("/api/approvals", t("汇报关系审批队列读取失败"));
  return <section className="rc-panel"><header><div><small>REPORTING LINE</small><h2>{t("汇报关系调整")}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.requests.length ? <EmptyState title={t("没有待审批汇报关系")} description={t("当前组织范围内没有待处理调整。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("成员")}</th><th>{t("目标上级")}</th><th>{t("原因")}</th><th>{t("进度")}</th><th>{t("复核")}</th></tr></thead><tbody>{resource.data.requests.map((item) => <tr key={item.id}><td><code>{item.subjectId}</code><small>{formatDateTime(item.requestedAt, locale)}</small></td><td><code>{item.newReportsToUserId ?? "—"}</code></td><td>{item.reason}<small>{t("申请人")} {item.requestedBy}</small></td><td>{item.approvals}/{item.required}</td><td>{item.canReview ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => onDecision({ kind: "reporting", id: item.id, decision: "approve", label: t("汇报关系调整") })}>{t("批准")}</button><button className="rc-button rc-danger-button" type="button" onClick={() => onDecision({ kind: "reporting", id: item.id, decision: "reject", label: t("汇报关系调整") })}>{t("拒绝")}</button></div> : <StatusBadge value={t("禁止自审")} />}</td></tr>)}</tbody></table></div>}</section>;
}

function CreditApprovals({ onDecision }: { onDecision: (decision: PendingDecision) => void }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ data: Array<{ id: string; requestNo: string; customerId: string; customerEmail: string | null; amountDelta: string; reason: string; status: string; requestedBy: { userId: string; email: string | null }; requestedAt: string; canReview: boolean }> }>("/api/operations/credit-adjustments?status=pending&limit=100", t("Credits 审批队列读取失败"));
  return <section className="rc-panel"><header><div><small>Credits</small><h2>{t("Credits 调整申请")}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.data.length ? <EmptyState title={t("没有待审批 Credits 调整")} description={t("队列中没有当前数据范围内的申请。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("申请")}</th><th>{t("客户")}</th><th>{t("调整数")}</th><th>{t("申请人")}</th><th>{t("复核")}</th></tr></thead><tbody>{resource.data.data.map((item) => <tr key={item.id}><td><b>{item.requestNo}</b><small>{item.reason}</small></td><td><code>{item.customerId}</code><small>{item.customerEmail ?? "—"}</small></td><td>{formatDecimal(item.amountDelta, 0)}</td><td>{item.requestedBy.email ?? item.requestedBy.userId}<small>{formatDateTime(item.requestedAt, locale)}</small></td><td>{item.canReview ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => onDecision({ kind: "credit", id: item.id, decision: "approve", label: item.requestNo })}>{t("批准")}</button><button className="rc-button rc-danger-button" type="button" onClick={() => onDecision({ kind: "credit", id: item.id, decision: "reject", label: item.requestNo })}>{t("拒绝")}</button></div> : <StatusBadge value={t("禁止自审")} />}</td></tr>)}</tbody></table></div>}</section>;
}

function AttributionApprovals({ onDecision }: { onDecision: (decision: PendingDecision) => void }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ data: Array<{ id: string; requestNo: string; customerId: string; customerEmail: string | null; proposedAssignment: { managerId: string; supervisorId: string | null; employeeId: string | null }; effectiveAt: string; reason: string; requestedBy: { userId: string; email: string | null }; requestedAt: string; canReview: boolean }> }>("/api/operations/attribution-changes?status=pending&limit=100", t("客户归属审批队列读取失败"));
  return <section className="rc-panel"><header><div><small>CUSTOMER ATTRIBUTION</small><h2>{t("客户归属调整")}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></header>{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.data.length ? <EmptyState title={t("没有待审批归属调整")} description={t("队列中没有当前数据范围内的申请。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("申请")}</th><th>{t("客户")}</th><th>{t("目标归属")}</th><th>{t("生效时间")}</th><th>{t("复核")}</th></tr></thead><tbody>{resource.data.data.map((item) => <tr key={item.id}><td><b>{item.requestNo}</b><small>{item.reason}</small><small>{item.requestedBy.email ?? item.requestedBy.userId}</small></td><td><code>{item.customerId}</code><small>{item.customerEmail ?? "—"}</small></td><td><small>{t("经理")} {item.proposedAssignment.managerId}</small><small>{t("主管")} {item.proposedAssignment.supervisorId ?? "—"}</small><small>{t("员工")} {item.proposedAssignment.employeeId ?? "—"}</small></td><td>{formatDateTime(item.effectiveAt, locale)}</td><td>{item.canReview ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => onDecision({ kind: "attribution", id: item.id, decision: "approve", label: item.requestNo })}>{t("批准")}</button><button className="rc-button rc-danger-button" type="button" onClick={() => onDecision({ kind: "attribution", id: item.id, decision: "reject", label: item.requestNo })}>{t("拒绝")}</button></div> : <StatusBadge value={t("禁止自审")} />}</td></tr>)}</tbody></table></div>}</section>;
}

function DepositApprovals({ onDecision }: { onDecision: (decision: PendingDecision) => void }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ actionRequests: OperationsActionRequest[] }>("/api/operations/deposit-action-requests?status=pending&limit=100", t("资金审批队列读取失败"));
  return <section className="rc-panel"><header><div><small>{t("资金操作")}</small><h2>{t("充值人工操作申请")}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></header>
    {resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.actionRequests.length ? <EmptyState title={t("没有待审批资金操作")} description={t("队列中没有当前数据范围内的申请。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("订单")}</th><th>{t("申请")}</th><th>{t("金额")}</th><th>{t("申请人")}</th><th>{t("复核")}</th></tr></thead><tbody>{resource.data.actionRequests.map((item) => <tr key={item.id}><td><a className="rc-table-link" href={`/deposits/${item.depositOrderId}`}>{item.platformOrderNo}</a><small>{item.customerEmail || "—"}</small></td><td><b>{item.action}</b><small>{item.reason}</small><small>{formatDateTime(item.requestedAt, locale)}</small></td><td>{formatDecimal(item.actualAmount)} {item.currency}</td><td><small>{item.requestedBy.email || item.requestedBy.userId}</small></td><td>{item.canReview ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => onDecision({ kind: "deposit", id: item.id, decision: "approve", label: item.action })}>{t("批准")}</button><button className="rc-button rc-danger-button" type="button" onClick={() => onDecision({ kind: "deposit", id: item.id, decision: "reject", label: item.action })}>{t("拒绝")}</button></div> : <StatusBadge value={t("禁止自审")} />}</td></tr>)}</tbody></table></div>}
  </section>;
}

function AccessApprovals({ onDecision }: { onDecision: (decision: PendingDecision) => void }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ changeRequests: AccessChangeRequest[] }>("/api/access/change-requests?status=pending&limit=100", t("授权审批队列读取失败"));
  return <section className="rc-panel"><header><div><small>{t("敏感授权")}</small><h2>{t("角色变更申请")}</h2></div><button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button></header>
    {resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.changeRequests.length ? <EmptyState title={t("没有待审批授权")} description={t("当前应用没有等待复核的角色变更。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("类型")}</th><th>{t("目标")}</th><th>{t("申请人")}</th><th>{t("状态")}</th><th>{t("复核")}</th></tr></thead><tbody>{resource.data.changeRequests.map((item) => <tr key={item.id}><td><b>{item.changeType}</b><small>{item.reason}</small></td><td>{item.targetRoleName || item.targetUserEmail || t("新建对象")}</td><td><small>{item.requestedBy.email || item.requestedBy.userId}</small><small>{formatDateTime(item.requestedAt, locale)}</small></td><td><StatusBadge value={item.status} /></td><td>{item.canReview ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => onDecision({ kind: "access", id: item.id, decision: "approve", label: item.changeType })}>{t("批准")}</button><button className="rc-button rc-danger-button" type="button" onClick={() => onDecision({ kind: "access", id: item.id, decision: "reject", label: item.changeType })}>{t("拒绝")}</button></div> : <StatusBadge value={t("禁止自审")} />}</td></tr>)}</tbody></table></div>}
  </section>;
}
