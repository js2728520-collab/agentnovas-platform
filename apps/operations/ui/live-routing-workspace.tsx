"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

import styles from "./kill-switch-workspace.module.css";

type LiveRoutingView = {
  id: string;
  exchange: string;
  environment: "demo" | "live";
  product: string;
  status: "pending" | "granted" | "revoked";
  requestedBy: string;
  requestedAt: string;
  requestNote: string;
  grantedBy: string | null;
  grantedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};

const STATUS_LABELS: Record<LiveRoutingView["status"], string> = {
  pending: "待批准",
  granted: "已生效",
  revoked: "已关停",
};

type PendingAction =
  | { kind: "request"; exchange: string; environment: "demo" | "live" }
  | { kind: "grant"; entry: LiveRoutingView }
  | { kind: "revoke"; entry: LiveRoutingView };

export function LiveRoutingWorkspace({ canManage }: { canManage: boolean }) {
  const resource = useApiData<{ grants: LiveRoutingView[] }>(
    "/api/operations/live-routing",
    "实盘路由授权读取失败",
  );
  const [exchange, setExchange] = useState("okx");
  const [environment, setEnvironment] = useState<"demo" | "live">("live");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submitPending(note: string) {
    if (!pending || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const request = pending.kind === "request"
        ? { url: "/api/operations/live-routing", method: "POST", body: { exchange: pending.exchange, environment: pending.environment, note } }
        : pending.kind === "grant"
          ? { url: `/api/operations/live-routing/${pending.entry.id}`, method: "PATCH", body: {} }
          : { url: `/api/operations/live-routing/${pending.entry.id}`, method: "DELETE", body: { reason: note } };
      const response = await fetch(request.url, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "实盘路由操作失败"));
      setMessage(pending.kind === "request"
        ? "开通申请已提交，尚未生效，需要另一位运营批准。"
        : pending.kind === "grant"
          ? "已批准，该交易所与环境的现货路由开始生效。"
          : "已关停，该交易所与环境立即停止真实下单。");
      setPending(null);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "实盘路由操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <LoadingState label="正在读取实盘路由授权…" />;
  if (resource.error) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const grants = resource.data?.grants ?? [];
  const open = grants.filter((entry) => entry.status !== "revoked");
  const history = grants.filter((entry) => entry.status === "revoked");

  return (
    <section className={styles.workspace}>
      <PageHeading
        eyebrow="风控"
        title="实盘路由"
        description="按交易所与环境逐条开通真实下单。默认全关；永续合约不在开通范围内，任何配置都无法打开。"
      />

      {message ? <p className={styles.message}>{message}</p> : null}

      {canManage ? (
        <form
          className={styles.engageForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!exchange.trim()) return;
            setPending({ kind: "request", exchange: exchange.trim().toLowerCase(), environment });
          }}
        >
          <h3 className={styles.formTitle}>申请开通</h3>
          <p className={styles.formNote}>
            申请不会立即生效，必须由另一位运营批准——开通是把风险放回去的方向。
            关停则单人即时生效，无需复核。
          </p>
          <div className={styles.formRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>交易所</span>
              <input className={styles.input} value={exchange} onChange={(event) => setExchange(event.target.value)} placeholder="okx" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>环境</span>
              <select
                className={styles.select}
                value={environment}
                onChange={(event) => setEnvironment(event.target.value as "demo" | "live")}
              >
                <option value="demo">模拟盘 demo</option>
                <option value="live">实盘 live</option>
              </select>
            </label>
            <button className={styles.secondary} type="submit" disabled={busy || !exchange.trim()}>
              提交申请
            </button>
          </div>
          <p className={styles.hint}>开通 demo 不等于开通实盘，两者分别批准。</p>
        </form>
      ) : null}

      <h3 className={styles.sectionTitle}>当前授权（{open.length}）</h3>
      {open.length === 0 ? (
        <EmptyState title="没有任何实盘路由授权" description="所有交易所均不会产生真实订单。" />
      ) : (
        <ul className={styles.list}>
          {open.map((entry) => (
            <li key={entry.id} className={styles.card}>
              <div className={styles.cardHead}>
                <StatusBadge value={STATUS_LABELS[entry.status]} />
                <span className={styles.scope}>{entry.exchange} · {entry.environment} · {entry.product}</span>
              </div>
              <p className={styles.reason}>{entry.requestNote}</p>
              <p className={styles.meta}>
                {formatDateTime(entry.requestedAt)} 由 {entry.requestedBy} 申请
                {entry.grantedAt ? ` · ${formatDateTime(entry.grantedAt)} 由 ${entry.grantedBy} 批准` : ""}
              </p>
              {canManage ? (
                <div className={styles.actions}>
                  {entry.status === "pending" ? (
                    <button className={styles.secondary} type="button" disabled={busy}
                      onClick={() => setPending({ kind: "grant", entry })}>
                      批准开通
                    </button>
                  ) : null}
                  <button className={styles.danger} type="button" disabled={busy}
                    onClick={() => setPending({ kind: "revoke", entry })}>
                    立即关停
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className={styles.sectionTitle}>历史（{history.length}）</h3>
      {history.length === 0 ? (
        <EmptyState title="暂无关停记录" description="关停过的授权会保留在这里，作为事后复盘的依据。" />
      ) : (
        <ul className={styles.list}>
          {history.map((entry) => (
            <li key={entry.id} className={`${styles.card} ${styles.released}`}>
              <div className={styles.cardHead}>
                <StatusBadge value={STATUS_LABELS[entry.status]} />
                <span className={styles.scope}>{entry.exchange} · {entry.environment}</span>
              </div>
              <p className={styles.reason}>{entry.revokeReason}</p>
              <p className={styles.meta}>
                {entry.revokedAt ? `${formatDateTime(entry.revokedAt)} 由 ${entry.revokedBy} 关停` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <ConfirmActionDialog
          open
          title={pending.kind === "request" ? "申请开通实盘路由"
            : pending.kind === "grant" ? "批准开通" : "立即关停"}
          description={pending.kind === "request"
            ? `确认后提交 ${pending.exchange} · ${pending.environment} 的开通申请。申请不会生效，需要另一位运营批准。`
            : pending.kind === "grant"
              ? `批准后 ${pending.entry.exchange} · ${pending.entry.environment} 将开始产生真实订单。发起人不能批准自己的申请。`
              : `关停后 ${pending.entry.exchange} · ${pending.entry.environment} 立即停止真实下单。已有仓位不受影响，平仓照常。`}
          confirmLabel={pending.kind === "request" ? "提交申请" : pending.kind === "grant" ? "批准" : "关停"}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={submitPending}
        />
      ) : null}
    </section>
  );
}
