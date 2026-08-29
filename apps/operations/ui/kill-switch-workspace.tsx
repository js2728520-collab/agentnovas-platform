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
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import styles from "./kill-switch-workspace.module.css";

type KillSwitchView = {
  id: string;
  dimension: "exchange" | "account" | "strategy";
  scopeValue: string;
  reason: string;
  active: boolean;
  engagedBy: string;
  engagedAt: string;
  releaseRequestId: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
};

const DIMENSION_LABELS: Record<KillSwitchView["dimension"], string> = {
  exchange: "交易所",
  account: "客户账户",
  strategy: "策略卡",
};

const DIMENSION_HINTS: Record<KillSwitchView["dimension"], string> = {
  exchange: "该交易所的全部客户都将停止开新仓，例如 okx",
  account: "只暂停这一个客户账户，填账户 ID",
  strategy: "订阅该策略卡的全部客户都将停止开新仓，填策略卡代号",
};

type PendingAction =
  | { kind: "engage"; dimension: KillSwitchView["dimension"]; scopeValue: string }
  | { kind: "request-release"; entry: KillSwitchView }
  | { kind: "approve-release"; entry: KillSwitchView };

export function KillSwitchWorkspace({ canManage }: { canManage: boolean }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ switches: KillSwitchView[] }>(
    "/api/operations/kill-switches",
    t("熔断开关读取失败"),
  );
  const [dimension, setDimension] = useState<KillSwitchView["dimension"]>("exchange");
  const [scopeValue, setScopeValue] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submitPending(note: string) {
    if (!pending || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const request = pending.kind === "engage"
        ? { url: "/api/operations/kill-switches", method: "POST", body: { dimension: pending.dimension, scopeValue: pending.scopeValue, reason: note } }
        : pending.kind === "request-release"
          ? { url: `/api/operations/kill-switches/${pending.entry.id}/release`, method: "POST", body: { note } }
          : { url: `/api/operations/kill-switches/${pending.entry.id}/release`, method: "PATCH", body: { note } };
      const response = await fetch(request.url, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = t("熔断操作失败");
        const detail = apiErrorMessage(payload, fallback);
        throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
      }
      setMessage(pending.kind === "engage"
        ? t("熔断已生效，该范围内不再开新仓；平仓不受影响。")
        : pending.kind === "request-release"
          ? t("解除申请已提交，熔断仍然生效，需另一位运营批准。")
          : t("熔断已解除，该范围恢复开新仓。"));
      setPending(null);
      setScopeValue("");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("熔断操作失败"));
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading) return <LoadingState label={t("正在读取熔断开关…")} />;
  if (resource.error) return <ErrorState message={resource.error} retry={resource.refresh} />;

  const switches = resource.data?.switches ?? [];
  const active = switches.filter((entry) => entry.active);
  const history = switches.filter((entry) => !entry.active);

  return (
    <section className={styles.workspace}>
      <PageHeading
        eyebrow={t("风控")}
        title={t("交易熔断")}
        description={t("按交易所、客户账户或策略卡暂停新开仓。平仓永远不受熔断影响——退出能力不依赖任何一层在线。")}
      />

      {message ? <p className={styles.message}>{message}</p> : null}

      {canManage ? (
        <form
          className={styles.engageForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!scopeValue.trim()) return;
            setPending({ kind: "engage", dimension, scopeValue: scopeValue.trim() });
          }}
        >
          <h3 className={styles.formTitle}>{t("挂起熔断")}</h3>
          <p className={styles.formNote}>
            {t("挂起立即生效，无需复核——出事的时候没有时间等第二个人批准。解除则必须由另一位运营批准。")}
          </p>
          <div className={styles.formRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t("维度")}</span>
              <select
                className={styles.select}
                value={dimension}
                onChange={(event) => setDimension(event.target.value as KillSwitchView["dimension"])}
              >
                {(Object.keys(DIMENSION_LABELS) as KillSwitchView["dimension"][]).map((key) => (
                  <option key={key} value={key}>{t(DIMENSION_LABELS[key])}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t("对象")}</span>
              <input
                className={styles.input}
                value={scopeValue}
                onChange={(event) => setScopeValue(event.target.value)}
                placeholder={t(DIMENSION_HINTS[dimension])}
              />
            </label>
            <button className={styles.danger} type="submit" disabled={busy || !scopeValue.trim()}>
              {t("挂起熔断")}
            </button>
          </div>
          <p className={styles.hint}>{t(DIMENSION_HINTS[dimension])}</p>
        </form>
      ) : null}

      <h3 className={styles.sectionTitle}>{t("生效中")}（{active.length}）</h3>
      {active.length === 0 ? (
        <EmptyState title={t("当前没有生效中的熔断")} description={t("所有交易所、账户与策略卡均可正常开新仓。")} />
      ) : (
        <ul className={styles.list}>
          {active.map((entry) => (
            <li key={entry.id} className={styles.card}>
              <div className={styles.cardHead}>
                <StatusBadge value={t(DIMENSION_LABELS[entry.dimension])} />
                <span className={styles.scope}>{entry.scopeValue}</span>
              </div>
              <p className={styles.reason}>{entry.reason}</p>
              <p className={styles.meta}>
                {formatDateTime(entry.engagedAt, locale)} {t("由")} {entry.engagedBy} {t("挂起")}
              </p>
              {canManage ? (
                entry.releaseRequestId ? (
                  <div className={styles.actions}>
                    <span className={styles.pendingNote}>{t("已有解除申请，等待另一位运营批准")}</span>
                    <button
                      className={styles.secondary}
                      type="button"
                      disabled={busy}
                      onClick={() => setPending({ kind: "approve-release", entry })}
                    >
                      {t("批准解除")}
                    </button>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <button
                      className={styles.secondary}
                      type="button"
                      disabled={busy}
                      onClick={() => setPending({ kind: "request-release", entry })}
                    >
                      {t("申请解除")}
                    </button>
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className={styles.sectionTitle}>{t("历史")}（{history.length}）</h3>
      {history.length === 0 ? (
        <EmptyState title={t("暂无历史记录")} description={t("解除过的熔断会保留在这里，作为事后复盘的依据。")} />
      ) : (
        <ul className={styles.list}>
          {history.map((entry) => (
            <li key={entry.id} className={`${styles.card} ${styles.released}`}>
              <div className={styles.cardHead}>
                <StatusBadge value={t(DIMENSION_LABELS[entry.dimension])} />
                <span className={styles.scope}>{entry.scopeValue}</span>
              </div>
              <p className={styles.reason}>{entry.reason}</p>
              <p className={styles.meta}>
                {formatDateTime(entry.engagedAt, locale)} {t("由")} {entry.engagedBy} {t("挂起")}
                {entry.releasedAt ? ` · ${formatDateTime(entry.releasedAt, locale)} ${t("由")} ${entry.releasedBy} ${t("解除")}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <ConfirmActionDialog
          title={pending.kind === "engage" ? t("挂起熔断")
            : pending.kind === "request-release" ? t("申请解除熔断") : t("批准解除熔断")}
          description={pending.kind === "engage"
            ? `${t("确认后")} ${t(DIMENSION_LABELS[pending.dimension])} “${pending.scopeValue}” ${t("范围内立即停止开新仓。平仓不受影响。")}`
            : pending.kind === "request-release"
              ? t("提交申请后熔断仍然生效，需要另一位运营批准才会真正解除。")
              : t("批准后该范围立即恢复开新仓。发起人不能批准自己的申请。")}
          open
          confirmLabel={pending.kind === "engage" ? t("挂起") : pending.kind === "request-release" ? t("提交申请") : t("批准解除")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={submitPending}
        />
      ) : null}
    </section>
  );
}
