"use client";

import { useEffect, useMemo, useState } from "react";

import type { CursorPage } from "./commercial-workspace-types";
import { formatDateTime, formatDecimal } from "@/packages/contracts/src/riverton-ui";
import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type CreditAccountView = {
  customerId: string;
  accountStatus: "ACTIVE" | "NOT_OPENED";
  available: string;
  reserved: string;
  version: string;
  updatedAt: string;
};

type CreditAdjustmentView = {
  id: string;
  requestNo: string;
  customerId: string;
  customerEmail: string | null;
  amountDelta: string;
  reason: string;
  evidenceReference: string;
  status: string;
  requestedBy: { userId: string; email: string | null };
  requestedAt: string;
  decidedBy: { userId: string; email: string | null } | null;
  decisionNote: string | null;
  decidedAt: string | null;
  canReview: boolean;
};

type PendingAction =
  | { kind: "create"; customerId: string; idempotencyKey: string }
  | { kind: "decision"; adjustment: CreditAdjustmentView; decision: "approve" | "reject"; idempotencyKey: string };

export function CreditsWorkspace({ canAdjust, canApprove }: { canAdjust: boolean; canApprove: boolean }) {
  const [ready, setReady] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [draftCustomerId, setDraftCustomerId] = useState("");
  const [cursor, setCursor] = useState("");
  const [amountDelta, setAmountDelta] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const initialCustomer = params.get("customerId") ?? "";
      setCustomerId(initialCustomer);
      setDraftCustomerId(initialCustomer);
      setCursor(params.get("cursor") ?? "");
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const url = useMemo(() => {
    if (!ready) return null;
    const params = new URLSearchParams({ limit: "30" });
    if (customerId) params.set("customerId", customerId);
    if (cursor) params.set("cursor", cursor);
    return `/api/operations/credits?${params}`;
  }, [cursor, customerId, ready]);
  const resource = useApiData<CursorPage<CreditAccountView>>(
    url,
    "Credits 账户读取失败",
  );
  const adjustments = useApiData<CursorPage<CreditAdjustmentView>>("/api/operations/credit-adjustments?limit=50", "Credits 调整队列读取失败");
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams();
    if (customerId) params.set("customerId", customerId);
    if (cursor) params.set("cursor", cursor);
    window.history.replaceState(
      null,
      "",
      `/credits${params.size ? `?${params}` : ""}`,
    );
  }, [cursor, customerId, ready]);

  async function submitPending(note: string) {
    if (!pending || busy) return;
    setBusy(true); setMessage("");
    try {
      const create = pending.kind === "create";
      const endpoint = create ? "/api/operations/credit-adjustments" : `/api/operations/credit-adjustments/${pending.adjustment.id}/decision`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": pending.idempotencyKey },
        body: JSON.stringify(create ? { customerId: pending.customerId, amountDelta, evidenceReference, reason: note } : { decision: pending.decision, note }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, create ? "Credits 调整提交失败" : "Credits 调整复核失败"));
      setMessage(create ? "Credits 调整已提交，尚未改变客户余额。" : pending.decision === "approve" ? "Credits 调整已复核并写入不可变分录。" : "Credits 调整已拒绝，客户余额未改变。");
      setPending(null); setConfirming(false); setAmountDelta(""); setEvidenceReference("");
      await Promise.all([resource.refresh(), adjustments.refresh()]);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Credits 操作失败"); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeading
        eyebrow="AI CREDITS"
        title="客户 Credits"
        description="展示当前 RBAC 数据范围内的可用与冻结余额；人工调整采用申请人与复核人分离，批准后才写入不可变分录。"
        actions={
          <button
            className="rc-button"
            type="button"
            onClick={() => void resource.refresh()}
          >
            刷新
          </button>
        }
      />
      <div className="rc-live" aria-live="polite">{message}</div>
      <section className="rc-panel">
        <header>
          <div>
            <small>SCOPED READ ONLY</small>
            <h2>Credits 账户</h2>
          </div>
        </header>
        <form
          className="rc-filter-row"
          onSubmit={(event) => {
            event.preventDefault();
            setCustomerId(draftCustomerId.trim());
            setCursor("");
          }}
        >
          <label>
            <span>客户 ID（精确）</span>
            <input
              maxLength={100}
              value={draftCustomerId}
              onChange={(event) => setDraftCustomerId(event.target.value)}
            />
          </label>
          <button className="rc-primary" type="submit">
            查询
          </button>
        </form>
        {!ready || (resource.loading && !resource.data) ? (
          <LoadingState label="正在读取 Credits 账户…" />
        ) : resource.error && !resource.data ? (
          <ErrorState message={resource.error} retry={resource.refresh} />
        ) : !resource.data?.data.length ? (
          <EmptyState
            title="没有 Credits 账户"
            description="当前查询或数据范围内没有客户账户。"
          />
        ) : (
          <div className="rc-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>客户</th>
                  <th>可用</th>
                  <th>冻结</th>
                  <th>账户状态</th>
                  <th>更新时间</th>
                  {canAdjust ? <th>调整</th> : null}
                </tr>
              </thead>
              <tbody>
                {resource.data.data.map((account) => (
                  <tr key={account.customerId}>
                    <td>
                      <code>{account.customerId}</code>
                      <small>版本 {account.version}</small>
                    </td>
                    <td>{formatDecimal(account.available, 0)}</td>
                    <td>{formatDecimal(account.reserved, 0)}</td>
                    <td>
                      <StatusBadge value={account.accountStatus} />
                    </td>
                    <td>{formatDateTime(account.updatedAt)}</td>
                    {canAdjust ? <td><button className="rc-button" type="button" onClick={() => { setAmountDelta(""); setEvidenceReference(""); setConfirming(false); setPending({ kind: "create", customerId: account.customerId, idempotencyKey: crypto.randomUUID() }); }}>发起调整</button></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {resource.data?.page.hasMore && (
          <div className="rc-action-row">
            <button
              className="rc-button"
              type="button"
              onClick={() =>
                setCursor(resource.data?.page.nextCursor ?? "")
              }
            >
              下一页
            </button>
          </div>
        )}
      </section>
      <section className="rc-panel">
        <header><div><small>MAKER / CHECKER</small><h2>Credits 调整队列</h2></div><button className="rc-button" type="button" onClick={() => void adjustments.refresh()}>刷新队列</button></header>
        {adjustments.loading && !adjustments.data ? <LoadingState label="正在读取调整队列…" /> : adjustments.error && !adjustments.data ? <ErrorState message={adjustments.error} retry={adjustments.refresh} /> : !adjustments.data?.data.length ? <EmptyState title="没有 Credits 调整" description="当前数据范围内没有调整申请。" /> : <div className="rc-table-wrap"><table><thead><tr><th>申请</th><th>客户</th><th>调整数</th><th>依据</th><th>状态</th><th>复核</th></tr></thead><tbody>{adjustments.data.data.map((adjustment) => <tr key={adjustment.id}><td><b>{adjustment.requestNo}</b><small>{adjustment.requestedBy.email ?? adjustment.requestedBy.userId}</small><small>{formatDateTime(adjustment.requestedAt)}</small></td><td><code>{adjustment.customerId}</code><small>{adjustment.customerEmail ?? "—"}</small></td><td>{formatDecimal(adjustment.amountDelta, 0)}</td><td><small>{adjustment.reason}</small><small>{adjustment.evidenceReference || "未附外部引用"}</small></td><td><StatusBadge value={adjustment.status} /></td><td>{canApprove && adjustment.canReview && adjustment.status === "pending" ? <div className="rc-action-row"><button className="rc-button" type="button" onClick={() => { setPending({ kind: "decision", adjustment, decision: "approve", idempotencyKey: crypto.randomUUID() }); setConfirming(true); }}>批准</button><button className="rc-button rc-danger-button" type="button" onClick={() => { setPending({ kind: "decision", adjustment, decision: "reject", idempotencyKey: crypto.randomUUID() }); setConfirming(true); }}>拒绝</button></div> : adjustment.status === "pending" && !adjustment.canReview ? <StatusBadge value="禁止自审" /> : <small>{adjustment.decisionNote ?? "—"}</small>}</td></tr>)}</tbody></table></div>}
      </section>
      {pending?.kind === "create" ? <section className="rc-panel rc-detail-panel"><header><div><small>{pending.customerId}</small><h2>填写 Credits 调整数</h2></div><button className="rc-button" type="button" onClick={() => setPending(null)}>取消</button></header><div className="rc-form rc-form-grid"><label>调整数（正数发放，负数扣减）<input inputMode="numeric" value={amountDelta} onChange={(event) => setAmountDelta(event.target.value)} placeholder="例如 1000 或 -100" /></label><label>外部凭证/工单引用（可选）<input maxLength={500} value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} /></label><p className="rc-wide-field">此步骤只提交申请；不同复核人批准后才会改变余额。负向调整不能使余额为负。</p><div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !/^-?[1-9]\d*$/.test(amountDelta)} onClick={() => setConfirming(true)}>继续填写原因并确认</button></div></div></section> : null}
      <ConfirmActionDialog open={confirming && pending !== null} title={pending?.kind === "create" ? "提交 Credits 调整申请" : `${pending?.decision === "approve" ? "批准" : "拒绝"} Credits 调整`} description={pending?.kind === "create" ? "请填写业务原因。提交后余额不会立即改变，必须由另一名有权限的复核人处理。" : "复核结果会进入不可变 Credits 分录或以拒绝状态留档。"} confirmLabel="确认提交" busy={busy} onCancel={() => { setConfirming(false); if (pending?.kind === "decision") setPending(null); }} onConfirm={(reason) => void submitPending(reason)} />
    </>
  );
}
