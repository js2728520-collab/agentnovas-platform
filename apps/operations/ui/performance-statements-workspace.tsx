"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { PaymentEvidenceForm } from "./payment-evidence-form";
import { commercialMutation } from "./commercial-mutation";
import type {
  CursorPage,
  PaymentEvidenceInput,
  PaymentEvidenceView,
  PerformanceFeeStatement,
  PerformanceStatementDetail,
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

type PendingDecision =
  | { stage: "assessment"; decision: "approve" | "reject"; idempotencyKey: string }
  | { stage: "payment"; decision: "approve" | "reject"; evidence: PaymentEvidenceView; idempotencyKey: string };

export function PerformanceStatementsWorkspace({
  statementId,
  canGenerate,
  canApprove,
  canRecordPaymentEvidence,
  canApprovePayment,
}: {
  statementId?: string;
  canGenerate: boolean;
  canApprove: boolean;
  canRecordPaymentEvidence: boolean;
  canApprovePayment: boolean;
}) {
  if (statementId) {
    return <PerformanceStatementDetailWorkspace
      statementId={statementId}
      canApprove={canApprove}
      canRecordPaymentEvidence={canRecordPaymentEvidence}
      canApprovePayment={canApprovePayment}
    />;
  }
  return <PerformanceStatementQueue canGenerate={canGenerate} />;
}

function PerformanceStatementQueue({ canGenerate }: { canGenerate: boolean }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
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
    return `/api/operations/performance-statements?${params}`;
  }, [cursor, ready, status]);
  const resource = useApiData<CursorPage<PerformanceFeeStatement>>(url, "周分成账单读取失败");
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    window.history.replaceState(null, "", `/performance-statements${params.size ? `?${params}` : ""}`);
  }, [cursor, ready, status]);

  async function generate() {
    if (!customerId.trim() || busy) return;
    setBusy(true); setMessage("");
    try {
      await commercialMutation("/api/operations/performance-statements/generate", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ userId: customerId.trim() }),
      }, "周分成账单生成失败");
      setMessage("上一完整 UTC 周的 paper 模拟净收益账单已生成，尚未完成业务审批或付款复核。");
      setCustomerId("");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "周分成账单生成失败"); }
    finally { setBusy(false); }
  }

  async function refresh() {
    await resource.refresh();
  }

  return <>
    <PageHeading
      eyebrow="PAPER PERFORMANCE FEES"
      title="周分成账单"
      description="仅按上一完整 UTC 周汇总三卡已平仓 paper 模拟净收益；业务审批与付款复核分离。"
      actions={<button className="rc-button" type="button" onClick={() => void refresh()}>刷新</button>}
    />
    <div className="rc-live" aria-live="polite">{message}</div>
    {canGenerate && <section className="rc-panel">
      <header><div><small>MAKER ACTION</small><h2>生成上一完整 UTC 周账单</h2><p>服务端固定解析官方三卡和会员快照；浏览器不能选择策略或收益口径。</p></div></header>
      <form className="rc-filter-row" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
        <label><span>客户 ID</span><input required maxLength={100} value={customerId} onChange={(event) => setCustomerId(event.target.value)} /></label>
        <button className="rc-primary" type="submit" disabled={busy || !customerId.trim()}>{busy ? "正在生成…" : "生成周账单"}</button>
      </form>
    </section>}
    <section className="rc-panel">
      <header><div><small>URL FILTERS</small><h2>分成队列</h2></div><label><span>状态</span><select value={status} onChange={(event) => { setStatus(event.target.value); setCursor(""); }}><option value="">全部状态</option><option value="SUBMITTED">等待业务审批</option><option value="APPROVED">已审批</option><option value="INVOICED">等待付款复核</option><option value="PAID">已付款复核</option><option value="CLOSED_NO_FEE">零费用关闭</option><option value="REJECTED">已拒绝</option></select></label></header>
      {!ready || (resource.loading && !resource.data) ? <LoadingState label="正在读取周分成账单…" />
        : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} />
          : !resource.data?.data.length ? <EmptyState title="没有周分成账单" description="当前筛选与数据范围内没有账单。" />
            : <div className="rc-table-wrap"><table><thead><tr><th>周期</th><th>客户</th><th>paper 模拟净收益</th><th>应收</th><th>状态</th></tr></thead><tbody>{resource.data.data.map((statement) => <tr key={statement.id}>
              <td><Link className="rc-table-link" href={`/performance-statements/${encodeURIComponent(statement.id)}`}>{formatDateTime(statement.cycleStartedAt)}</Link><small>至 {formatDateTime(statement.cycleEndedAt)} · 修订 {statement.revision}</small></td>
              <td><code>{statement.customerId}</code></td>
              <td>{formatDecimal(statement.cumulativeNetRealizedPnl)} USDT<small>高水位 {formatDecimal(statement.settledHighWaterMark)}</small></td>
              <td><b>{formatDecimal(statement.feeAmount)} USDT</b><small>计费基数 {formatDecimal(statement.billableProfit)} · 费率 {Number(statement.feeRate) * 100}%</small></td>
              <td><StatusBadge value={statement.status} /><small>{statement.replacesStatementId ? `替代 ${statement.replacesStatementId}` : "首版"}</small></td>
            </tr>)}</tbody></table></div>}
      {resource.data?.page.hasMore && <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => setCursor(resource.data?.page.nextCursor ?? "")}>下一页</button></div>}
    </section>
  </>;
}

function PerformanceStatementDetailWorkspace({
  statementId,
  canApprove,
  canRecordPaymentEvidence,
  canApprovePayment,
}: {
  statementId: string;
  canApprove: boolean;
  canRecordPaymentEvidence: boolean;
  canApprovePayment: boolean;
}) {
  const resource = useApiData<PerformanceStatementDetail>(
    `/api/operations/performance-statements/${encodeURIComponent(statementId)}`,
    "周分成账单详情读取失败",
  );
  const [showEvidence, setShowEvidence] = useState(false);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function mutate(path: string, body: unknown, key: string) {
    return commercialMutation(`/api/operations/performance-statements/${encodeURIComponent(statementId)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    }, "周分成操作失败");
  }

  async function recordEvidence(input: PaymentEvidenceInput) {
    setBusy(true); setMessage("");
    try {
      await mutate("/payment-evidence", input, crypto.randomUUID());
      setMessage("外部付款凭证已记录，账单尚未标记 PAID，高水位尚未提交。");
      setShowEvidence(false);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "付款凭证记录失败"); }
    finally { setBusy(false); }
  }

  async function decide(reason: string) {
    if (!pending) return;
    setBusy(true); setMessage("");
    try {
      const path = pending.stage === "assessment" ? "/decision" : "/payment-decision";
      const paymentEvidenceId = pending.stage === "payment" ? pending.evidence.id : undefined;
      const result = await mutate(path, {
        decision: pending.decision,
        note: reason,
        ...(paymentEvidenceId ? { paymentEvidenceId } : {}),
      }, pending.idempotencyKey);
      setMessage(pending.stage === "assessment"
        ? "业务审批已记录；仅形成应收或零费用关闭，不表示已收款，也不会自动扣款。"
        : pending.decision === "approve" && result.status === "PAID"
          ? "付款复核已记录，账单标记 PAID 并由服务端事务提交高水位；平台未执行外部支付。"
          : "付款复核决定已记录；未执行外部退款或资金操作。");
      setPending(null);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "周分成审批失败"); }
    finally { setBusy(false); }
  }

  async function refresh() {
    await resource.refresh();
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取周分成详情…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message="周分成详情不可用" retry={resource.refresh} />;
  const { statement, evidence, decisions, actions } = resource.data;
  return <>
    <PageHeading
      eyebrow={`REVISION ${statement.revision}`}
      title="paper 模拟净收益分成"
      description="业务审批、外部付款凭证和付款 checker 是三个独立阶段；只有最终付款复核才提交高水位。"
      actions={<><Link className="rc-button" href="/performance-statements">返回队列</Link><button className="rc-button" type="button" onClick={() => void refresh()}>刷新</button></>}
    />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-kpi-grid" aria-label="周分成摘要">
      <article><small>状态</small><strong className="rc-kpi-status"><StatusBadge value={statement.status} /></strong><span>修订 {statement.revision}</span></article>
      <article><small>paper 累计净已实现</small><strong>{formatDecimal(statement.cumulativeNetRealizedPnl)} USDT</strong><span>仅官方三卡已平仓口径</span></article>
      <article><small>计费基数</small><strong>{formatDecimal(statement.billableProfit)} USDT</strong><span>已结算高水位 {formatDecimal(statement.settledHighWaterMark)}</span></article>
      <article><small>应收</small><strong>{formatDecimal(statement.feeAmount)} USDT</strong><span>费率 {Number(statement.feeRate) * 100}%</span></article>
    </section>
    <section className="rc-panel">
      <header><div><small>{formatDateTime(statement.cycleStartedAt)} — {formatDateTime(statement.cycleEndedAt)}</small><h2>业务审批</h2></div></header>
      {canApprove && actions.canReviewAssessment ? <div className="rc-action-row">
        <button className="rc-button" type="button" onClick={() => setPending({ stage: "assessment", decision: "approve", idempotencyKey: crypto.randomUUID() })}>批准业务账单</button>
        <button className="rc-button rc-danger-button" type="button" onClick={() => setPending({ stage: "assessment", decision: "reject", idempotencyKey: crypto.randomUUID() })}>拒绝并允许受控重开</button>
      </div> : statement.status === "SUBMITTED" && <p className="rc-muted">当前账户不可自审，或缺少业务审批权限。</p>}
    </section>
    <section className="rc-panel">
      <header><div><small>{evidence.length} 条凭证</small><h2>外部付款复核</h2></div></header>
      {!evidence.length ? <EmptyState title="尚无付款凭证" description="账单形成应收后，由 maker 记录外部付款凭证。" /> : <div className="rc-card-list">{evidence.map((item) => <article key={item.id}>
        <header><div><b>{item.referenceMasked}</b><small>{item.kind} · {item.providerLabel || "未标注渠道"}</small></div><StatusBadge value={item.status} /></header>
        <p>{formatDecimal(item.amount)} {item.currency} · {formatDateTime(item.occurredAt)}</p>
        <small>记录人 {item.recordedByUserId} · {item.note || "无附注"}</small>
        {canApprovePayment && item.canReview && <div className="rc-action-row rc-card-actions">
          <button className="rc-button" type="button" onClick={() => setPending({ stage: "payment", decision: "approve", evidence: item, idempotencyKey: crypto.randomUUID() })}>复核为已支付</button>
          <button className="rc-button rc-danger-button" type="button" onClick={() => setPending({ stage: "payment", decision: "reject", evidence: item, idempotencyKey: crypto.randomUUID() })}>拒绝该凭证</button>
        </div>}
      </article>)}</div>}
      <div className="rc-action-row">
        {canRecordPaymentEvidence && actions.canRecordPaymentEvidence && <button className="rc-button" type="button" disabled={busy} onClick={() => setShowEvidence(true)}>记录外部付款凭证</button>}
        {canApprovePayment && statement.status === "INVOICED" && !actions.canReviewPayment && <span className="rc-muted">当前账户不可复核自己记录的凭证。</span>}
      </div>
    </section>
    <section className="rc-panel">
      <header><div><small>{decisions.length} 条决定</small><h2>不可变审批轨迹</h2></div></header>
      {!decisions.length ? <EmptyState title="尚无审批记录" description="每个阶段的 checker 决定会在这里显示。" /> : <div className="rc-card-list">{decisions.map((item) => <article key={item.id}><header><b>{item.stage} · {item.decision}</b><StatusBadge value="审批已记录" /></header><small>{item.reviewerUserId} · {formatDateTime(item.createdAt)} · 凭证 {item.paymentEvidenceId || "—"}</small></article>)}</div>}
    </section>
    {showEvidence && <PaymentEvidenceForm currency="USDT" busy={busy} onCancel={() => setShowEvidence(false)} onSubmit={(input) => void recordEvidence(input)} />}
    <ConfirmActionDialog
      open={Boolean(pending)}
      title={pending?.stage === "assessment" ? `${pending.decision === "approve" ? "批准" : "拒绝"}业务账单` : `${pending?.decision === "approve" ? "批准" : "拒绝"}付款凭证`}
      description={pending?.stage === "assessment" ? "业务批准只形成应收或零费用关闭，不会自动收款或更新高水位。" : "付款批准只确认外部凭证并提交高水位，不会执行外部支付。"}
      confirmLabel="确认记录决定"
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={(reason) => void decide(reason)}
    />
  </>;
}
