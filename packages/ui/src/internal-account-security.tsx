"use client";

import { useRef, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { ErrorState, LoadingState, PageHeading, StatusBadge } from "./page-state";
import { useApiData } from "./use-api-data";
import { useAppLocale } from "./app-locale-context";

type RecoveryStatus = {
  enforcementEnabled: boolean;
  enrolled: boolean;
  enabledAt: string | null;
  remainingRecoveryCodes: number;
  lastRotatedAt: string | null;
};

type AccountSession = {
  id: string;
  audience: "client" | "operations" | "maintenance";
  current: boolean;
  device: string;
  maskedIpAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  absoluteExpiresAt: string;
};

export function InternalAccountSecurity() {
  const { locale, t } = useAppLocale();
  const status = useApiData<RecoveryStatus>("/api/auth/mfa/recovery-codes", t("双重验证状态读取失败"));
  const sessions = useApiData<{ sessions: AccountSession[] }>("/api/account/sessions", t("登录设备读取失败"));
  const [dialog, setDialog] = useState<"rotate" | AccountSession | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const resultRef = useRef<HTMLDivElement>(null);

  function announce(value: string) {
    setMessage(value);
    window.setTimeout(() => resultRef.current?.focus(), 0);
  }

  async function submit(reason: string) {
    if (!dialog || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (dialog === "rotate") {
        const response = await fetch("/api/auth/mfa/recovery-codes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, t("恢复码轮换失败")));
        setRecoveryCodes(Array.isArray(payload.recoveryCodes) ? payload.recoveryCodes : []);
        announce(t("恢复码已轮换。旧的未使用恢复码已经失效。"));
        await status.refresh();
      } else {
        const response = await fetch("/api/account/sessions", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: dialog.id, reason }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, t("会话撤销失败")));
        announce(t("该设备会话已撤销。"));
        await sessions.refresh();
      }
      setDialog(null);
    } catch (error) {
      announce(error instanceof Error ? error.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading eyebrow="ACCOUNT ASSURANCE" title="账号与双重验证" description={status.data?.enforcementEnabled ? "核对 TOTP、恢复码和仍然有效的内部登录设备。恢复码轮换要求最近 15 分钟内完成 MFA。" : "双重验证能力与既有绑定数据均已保留，当前阶段暂不强制；正式投入生产后通过运行时开关启用。"} />
    <div ref={resultRef} className="rc-live" role="status" aria-live="polite" tabIndex={-1}>{message}</div>
    <section className="rc-panel">
      <header><div><small>MFA RECOVERY</small><h2>{t("恢复凭证")}</h2></div>{status.data ? <StatusBadge value={t(status.data.enforcementEnabled ? (status.data.enrolled ? "TOTP 已启用" : "尚未启用") : "当前暂不强制")} /> : null}</header>
      {status.loading && !status.data ? <LoadingState label="正在读取双重验证状态…" /> : status.error && !status.data ? <ErrorState message={status.error} retry={status.refresh} /> : <>
        <dl className="rc-description-list">
          <div><dt>{t("启用时间")}</dt><dd>{formatDateTime(status.data?.enabledAt, locale)}</dd></div>
          <div><dt>{t("剩余恢复码")}</dt><dd>{status.data?.remainingRecoveryCodes ?? 0} {t("枚")}</dd></div>
          <div><dt>{t("最近轮换")}</dt><dd>{formatDateTime(status.data?.lastRotatedAt, locale)}</dd></div>
        </dl>
        {!status.data?.enforcementEnabled ? <p className="rc-muted">{t("强制校验关闭期间不开放内部恢复码轮换；开启后仍需最近 15 分钟内完成 MFA。")}</p> : null}
        <div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy || !status.data?.enrolled || !status.data.enforcementEnabled} onClick={() => setDialog("rotate")}>{t("轮换恢复码")}</button></div>
      </>}
      {recoveryCodes ? <div className="rc-warning" role="alert">
        <strong>{t("恢复码仅显示这一次")}</strong>
        <p>{t("请立即保存到受控密码管理器。关闭或刷新页面后无法再次查看。")}</p>
        <ol>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ol>
        <button className="rc-button" type="button" onClick={() => setRecoveryCodes(null)}>{t("我已安全保存并关闭")}</button>
      </div> : null}
    </section>
    <section className="rc-panel">
      <header><div><small>ACTIVE SESSIONS</small><h2>{t("内部登录设备")}</h2></div><button className="rc-button" type="button" onClick={() => void sessions.refresh()}>{t("重新读取")}</button></header>
      {sessions.loading && !sessions.data ? <LoadingState label="正在读取登录设备…" /> : sessions.error && !sessions.data ? <ErrorState message={sessions.error} retry={sessions.refresh} /> : <div className="rc-card-grid">
        {sessions.data?.sessions.map((session) => <article className="rc-card" key={session.id}>
          <header><StatusBadge value={session.current ? t("当前设备") : session.audience} /><time>{formatDateTime(session.lastSeenAt ?? session.createdAt, locale)}</time></header>
          <h3>{session.device}</h3><p>{session.maskedIpAddress ?? t("未记录网络地址")}</p>
          <footer>{session.current ? <span className="rc-muted">{t("当前设备请使用账户菜单退出。")}</span> : <button className="rc-button" type="button" disabled={busy} onClick={() => setDialog(session)}>{t("撤销此设备")}</button>}</footer>
        </article>)}
      </div>}
    </section>
    <ConfirmActionDialog open={dialog !== null} title={dialog === "rotate" ? "轮换全部恢复码" : "撤销登录设备"} description={dialog === "rotate" ? "提交后全部旧的未使用恢复码立即失效，新码只显示一次。" : "该设备会立即失去访问权限，审计记录仍会保留。"} confirmLabel="确认执行" busy={busy} onCancel={() => setDialog(null)} onConfirm={(reason) => void submit(reason)} />
  </>;
}
