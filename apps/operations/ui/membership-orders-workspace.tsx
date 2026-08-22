"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { PaymentEvidenceForm } from "./payment-evidence-form";
import { commercialMutation } from "./commercial-mutation";
import type {
  CursorPage,
  MembershipOrder,
  MembershipOrderDetail,
  PaymentEvidenceInput,
  PaymentEvidenceView,
} from "./commercial-workspace-types";
import { formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type ReviewAction = {
  decision: "approve" | "reject";
  evidence: PaymentEvidenceView;
  idempotencyKey: string;
};

export function MembershipOrdersWorkspace({
  orderId,
  viewerUserId,
  canRecordEvidence,
  canApprove,
}: {
  orderId?: string;
  viewerUserId: string;
  canRecordEvidence: boolean;
  canApprove: boolean;
}) {
  if (orderId) {
    return (
      <MembershipOrderDetailWorkspace
        orderId={orderId}
        viewerUserId={viewerUserId}
        canRecordEvidence={canRecordEvidence}
        canApprove={canApprove}
      />
    );
  }
  return <MembershipOrderQueue />;
}

function MembershipOrderQueue() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      setStatus(params.get("status") ?? "");
      setCursor(params.get("cursor") ?? "");
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const url = useMemo(() => {
    if (!ready) return null;
    const params = new URLSearchParams({ limit: "30" });
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    return `/api/operations/membership-orders?${params}`;
  }, [cursor, ready, status]);
  const resource = useApiData<CursorPage<MembershipOrder>>(url, "会员订单读取失败");
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    window.history.replaceState(null, "", `/membership-orders${params.size ? `?${params}` : ""}`);
  }, [cursor, ready, status]);

  return (
    <>
      <PageHeading
        eyebrow="MEMBERSHIP OPERATIONS"
        title="会员订单"
        description="外部付款凭证、maker 提交与 checker 决策分离；列表仅含当前 RBAC 数据范围。"
        actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button>}
      />
      <section className="rc-panel">
        <header>
          <div><small>URL FILTERS</small><h2>订单队列</h2></div>
          <label>
            <span>状态</span>
            <select value={status} onChange={(event) => { setStatus(event.target.value); setCursor(""); }}>
              <option value="">全部状态</option>
              <option value="AWAITING_EVIDENCE">等待凭证</option>
              <option value="SUBMITTED">等待复核</option>
              <option value="ACTIVATED">已激活</option>
              <option value="REJECTED">已拒绝</option>
              <option value="CANCELLED">已取消</option>
            </select>
          </label>
        </header>
        {!ready || (resource.loading && !resource.data) ? <LoadingState label="正在读取会员订单…" />
          : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} />
            : !resource.data?.data.length ? <EmptyState title="没有会员订单" description="当前筛选与数据范围内没有订单。" />
              : <div className="rc-table-wrap">
                <table>
                  <thead><tr><th>订单</th><th>客户</th><th>计划快照</th><th>状态</th><th>时间</th></tr></thead>
                  <tbody>{resource.data.data.map((order) => <tr key={order.id}>
                    <td><Link className="rc-table-link" href={`/membership-orders/${encodeURIComponent(order.id)}`}>{order.orderNo}</Link><small>{order.id}</small></td>
                    <td><code>{order.customerId}</code></td>
                    <td><b>{order.plan.name}</b><small>{formatDecimal(order.plan.priceUsd, 2)} USD · {order.plan.aiCredits.toLocaleString("zh-CN")} credits</small></td>
                    <td><StatusBadge value={order.status} /><small>外部付款指引：{order.paymentInstructionsStatus}</small></td>
                    <td>{formatDateTime(order.createdAt)}<small>{order.activatedAt ? `激活 ${formatDateTime(order.activatedAt)}` : "尚未激活"}</small></td>
                  </tr>)}</tbody>
                </table>
              </div>}
        {resource.data?.page.hasMore && <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => setCursor(resource.data?.page.nextCursor ?? "")}>下一页</button></div>}
      </section>
    </>
  );
}

function MembershipOrderDetailWorkspace({
  orderId,
  viewerUserId,
  canRecordEvidence,
  canApprove,
}: {
  orderId: string;
  viewerUserId: string;
  canRecordEvidence: boolean;
  canApprove: boolean;
}) {
  const resource = useApiData<MembershipOrderDetail>(
    `/api/operations/membership-orders/${encodeURIComponent(orderId)}`,
    "会员订单详情读取失败",
  );
  const [showEvidence, setShowEvidence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [review, setReview] = useState<ReviewAction | null>(null);

  async function mutate(path: string, body: unknown, key: string) {
    return commercialMutation(`/api/operations/membership-orders/${encodeURIComponent(orderId)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    }, "会员订单操作失败");
  }

  async function recordEvidence(input: PaymentEvidenceInput) {
    setBusy(true); setMessage("");
    try {
      await mutate("/evidence", input, crypto.randomUUID());
      setMessage("外部付款凭证已记录，尚未完成会员审批。");
      setShowEvidence(false);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "付款凭证记录失败"); }
    finally { setBusy(false); }
  }

  async function submitForReview() {
    setBusy(true); setMessage("");
    try {
      await mutate("/submit", {}, crypto.randomUUID());
      setMessage("订单已提交 checker 复核，会员尚未激活。");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "订单提交失败"); }
    finally { setBusy(false); }
  }

  async function decide(reason: string) {
    if (!review) return;
    setBusy(true); setMessage("");
    try {
      const result = await mutate("/decision", {
        decision: review.decision,
        note: reason,
        paymentEvidenceId: review.evidence.id,
      }, review.idempotencyKey);
      setMessage(review.decision === "approve" && result.status === "ACTIVATED"
        ? "审批已记录，会员已激活；该回执不表示平台执行了外部收款。"
        : "审批决定已记录；外部资金状态未由平台改变。");
      setReview(null);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "会员审批失败"); }
    finally { setBusy(false); }
  }

  async function refresh() {
    await resource.refresh();
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取订单详情…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message="会员订单详情不可用" retry={resource.refresh} />;
  const { order, evidence, decisions, actions } = resource.data;
  const reviewable = evidence.filter((item) => item.canReview && item.recordedByUserId !== viewerUserId);
  return (
    <>
      <PageHeading
        eyebrow={order.orderNo}
        title={order.plan.name}
        description="订单、付款凭证和 checker 决定均来自服务端安全投影。"
        actions={<><Link className="rc-button" href="/membership-orders">返回队列</Link><button className="rc-button" type="button" onClick={() => void refresh()}>刷新</button></>}
      />
      <div className="rc-live" aria-live="polite">{message}</div>
      <section className="rc-kpi-grid" aria-label="会员订单摘要">
        <article><small>订单状态</small><strong className="rc-kpi-status"><StatusBadge value={order.status} /></strong><span>{order.orderNo}</span></article>
        <article><small>外部应付</small><strong>{formatDecimal(order.plan.priceUsd, 2)} USD</strong><span>人工外部付款</span></article>
        <article><small>会员 Credits</small><strong>{order.plan.aiCredits.toLocaleString("zh-CN")}</strong><span>仅在审批事务激活后发放</span></article>
        <article><small>paper 分成费率</small><strong>{Number(order.plan.performanceFeeRate) * 100}%</strong><span>计划不可变快照</span></article>
      </section>
      <section className="rc-panel">
        <header><div><small>{evidence.length} 条记录</small><h2>付款凭证与操作</h2></div></header>
        {!evidence.length ? <EmptyState title="尚无付款凭证" description="maker 需要先核对外部付款并记录脱敏凭证。" /> : <div className="rc-card-list">{evidence.map((item) => <article key={item.id}>
          <header><div><b>{item.referenceMasked}</b><small>{item.kind}</small></div><StatusBadge value={item.status} /></header>
          <p>{formatDecimal(item.amount, 2)} {item.currency} · 外部时间 {formatDateTime(item.occurredAt)}</p>
          <small>记录人 {item.recordedByUserId} · 附注仅保留于受控审计记录</small>
          {canApprove && item.canReview && item.recordedByUserId !== viewerUserId && <div className="rc-action-row rc-card-actions">
            <button className="rc-button" type="button" onClick={() => setReview({ decision: "approve", evidence: item, idempotencyKey: crypto.randomUUID() })}>批准并激活</button>
            <button className="rc-button rc-danger-button" type="button" onClick={() => setReview({ decision: "reject", evidence: item, idempotencyKey: crypto.randomUUID() })}>拒绝</button>
          </div>}
        </article>)}</div>}
        <div className="rc-action-row">
          {canRecordEvidence && actions.canRecordEvidence && <button className="rc-button" type="button" disabled={busy} onClick={() => setShowEvidence(true)}>记录付款凭证</button>}
          {canRecordEvidence && actions.canSubmit && <button className="rc-primary" type="button" disabled={busy} onClick={() => void submitForReview()}>提交 checker 复核</button>}
          {canApprove && order.status === "SUBMITTED" && !reviewable.length && <span className="rc-muted">当前账户不可自审，或没有可复核凭证。</span>}
        </div>
      </section>
      <section className="rc-panel">
        <header><div><small>{decisions.length} 条决定</small><h2>审批记录</h2></div></header>
        {!decisions.length ? <EmptyState title="尚无审批决定" description="提交后由不同 checker 记录批准或拒绝。" /> : <div className="rc-card-list">{decisions.map((item) => <article key={item.id}><header><b>{item.decision}</b><StatusBadge value="审批已记录" /></header><small>{item.reviewerUserId} · {formatDateTime(item.createdAt)} · 凭证 {item.paymentEvidenceId || "—"}</small></article>)}</div>}
      </section>
      {showEvidence && <PaymentEvidenceForm currency="USD" busy={busy} onCancel={() => setShowEvidence(false)} onSubmit={(input) => void recordEvidence(input)} />}
      <ConfirmActionDialog
        open={Boolean(review)}
        title={review?.decision === "approve" ? "批准会员订单" : "拒绝会员订单"}
        description={review?.decision === "approve" ? "批准事务将激活会员并发放一次 Credits，但不会执行外部收款。" : "拒绝只记录业务决定，不会执行退款或资金操作。"}
        confirmLabel={review?.decision === "approve" ? "确认批准" : "确认拒绝"}
        busy={busy}
        onCancel={() => setReview(null)}
        onConfirm={(reason) => void decide(reason)}
      />
    </>
  );
}
