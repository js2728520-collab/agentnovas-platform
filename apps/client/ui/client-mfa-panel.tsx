"use client";

import { useRef, useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { ErrorState, LoadingState, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type MfaStatus = {
  enforcementEnabled: boolean;
  enrolled: boolean;
  enabledAt: string | null;
  remainingRecoveryCodes: number;
  lastRotatedAt: string | null;
};

function setupKeyFromUri(value: unknown) {
  try {
    const secret = new URL(String(value)).searchParams.get("secret")?.trim();
    return secret && /^[A-Z2-7]{16,128}$/i.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

function recoveryCodesFromPayload(payload: Record<string, unknown>) {
  return Array.isArray(payload.recoveryCodes)
    ? payload.recoveryCodes.filter((code): code is string => typeof code === "string" && code.length > 0)
    : [];
}

export function ClientMfaPanel() {
  const { locale, t } = useAppLocale();
  const status = useApiData<MfaStatus>("/api/auth/mfa/recovery-codes", t("双重验证状态读取失败"));
  const [setupKey, setSetupKey] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  function announce(kind: "success" | "error", text: string) {
    setMessage({ kind, text });
    window.setTimeout(() => resultRef.current?.focus(), 0);
  }

  async function post(endpoint: string, body: Record<string, unknown>) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(apiErrorMessage(payload, t("双重验证操作失败")));
    return payload;
  }

  async function startEnrollment() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = await post("/api/auth/mfa/enroll/start", {});
      const secret = setupKeyFromUri(payload.otpauthUri);
      if (!secret) throw new Error(t("身份验证器设置密钥无效，请重新开始绑定"));
      setSetupKey(secret);
      announce("success", t("设置密钥已生成。请在身份验证器中添加后输入当前六位验证码。"));
    } catch (error) {
      announce("error", error instanceof Error ? error.message : t("双重验证绑定启动失败"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrollment() {
    if (busy || !/^\d{6}$/.test(confirmationCode)) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = await post("/api/auth/mfa/enroll/confirm", { code: confirmationCode });
      const codes = recoveryCodesFromPayload(payload);
      if (codes.length === 0) throw new Error(t("恢复码生成失败，请重新登录后再试"));
      setSetupKey("");
      setConfirmationCode("");
      setRecoveryCodes(codes);
      announce("success", t("双重验证已启用。恢复码只显示这一次，请立即安全保存。"));
      await status.refresh();
    } catch (error) {
      announce("error", error instanceof Error ? error.message : t("双重验证确认失败"));
    } finally {
      setBusy(false);
    }
  }

  async function rotateRecoveryCodes() {
    if (busy || verificationCode.trim().length < 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = await post("/api/auth/mfa/recovery-codes", { verificationCode });
      const codes = recoveryCodesFromPayload(payload);
      if (codes.length === 0) throw new Error(t("恢复码生成失败，请稍后重试"));
      setVerificationCode("");
      setRecoveryCodes(codes);
      announce("success", t("恢复码已轮换。旧的未使用恢复码已经失效，新恢复码只显示这一次。"));
      await status.refresh();
    } catch (error) {
      announce("error", error instanceof Error ? error.message : t("恢复码轮换失败"));
    } finally {
      setBusy(false);
    }
  }

  function acknowledgeRecoveryCodes() {
    setRecoveryCodes([]);
    announce("success", t("恢复码已从页面清除。后续无法再次查看，只能通过验证后轮换。"));
  }

  return <section className="rc-panel">
    <header><div><small>TWO-FACTOR AUTHENTICATION</small><h2>{t("双重验证")}{t(status.data?.enforcementEnabled ? "（已强制）" : "（当前暂不强制）")}</h2></div>{status.data ? <StatusBadge value={status.data.enrolled ? t("已绑定") : t("未绑定")} /> : null}</header>
    {message ? <div ref={resultRef} className={message.kind === "error" ? "rc-error" : "rc-live"} role={message.kind === "error" ? "alert" : "status"} aria-live={message.kind === "error" ? "assertive" : "polite"} tabIndex={-1}>{message.text}</div> : <div className="rc-live" aria-live="polite" />}
    {status.loading && !status.data ? <LoadingState label="正在读取双重验证状态…" /> : status.error && !status.data ? <ErrorState message={status.error} retry={status.refresh} /> : <>
      {!status.data?.enforcementEnabled ? <p className="rc-muted">{t("双重验证能力与绑定数据均已保留，当前阶段不会在登录时强制校验；正式投入生产并开启安全开关后生效。")}</p> : null}
      {!status.data?.enrolled && !setupKey ? <div className="rc-form"><p>{t(status.data?.enforcementEnabled ? "启用后，每次登录都必须输入身份验证器动态验证码或一枚未使用的恢复码。" : "现在可以预先绑定身份验证器；当前登录不会强制校验，正式启用开关后将使用这份绑定。")}</p><div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy} onClick={() => void startEnrollment()}>{t(busy ? "正在准备…" : "绑定身份验证器")}</button></div></div> : null}
      {setupKey ? <div className="rc-form rc-form-grid">
        <label className="rc-wide-field">{t("身份验证器设置密钥")}<input className="rc-mfa-setup-key" value={setupKey} readOnly aria-describedby="client-mfa-setup-help" /></label>
        <small id="client-mfa-setup-help" className="rc-wide-field">{t("该密钥仅在绑定过程中显示，不会写入浏览器存储。请勿截图或发送给他人。")}</small>
        <label>{t("六位动态验证码")}<input value={confirmationCode} onChange={(event) => setConfirmationCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" /></label>
        <div className="rc-action-row rc-wide-field"><button className="rc-primary" type="button" disabled={busy || !/^\d{6}$/.test(confirmationCode)} onClick={() => void confirmEnrollment()}>{t(busy ? "正在确认…" : "确认绑定并生成恢复码")}</button></div>
      </div> : null}
      {status.data?.enrolled && recoveryCodes.length === 0 ? <div className="rc-form rc-form-grid">
        <dl className="rc-wide-field"><div><dt>{t("启用时间")}</dt><dd>{formatDateTime(status.data.enabledAt, locale)}</dd></div><div><dt>{t("剩余恢复码")}</dt><dd>{status.data.remainingRecoveryCodes} {t("枚")}</dd></div><div><dt>{t("最近轮换")}</dt><dd>{formatDateTime(status.data.lastRotatedAt, locale)}</dd></div></dl>
        <label className="rc-wide-field">{t("当前动态验证码或恢复码")}<input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.slice(0, 64))} autoComplete="one-time-code" /><small>{t("轮换会立即使所有旧的未使用恢复码失效。")}</small></label>
        <div className="rc-action-row rc-wide-field"><button className="rc-button" type="button" disabled={busy || verificationCode.trim().length < 6} onClick={() => void rotateRecoveryCodes()}>{t(busy ? "正在轮换…" : "验证并轮换恢复码")}</button></div>
      </div> : null}
      {recoveryCodes.length > 0 ? <div className="rc-recovery-codes" role="status" aria-live="polite">
        <p><strong>{t("恢复码只显示一次。")}</strong>{t("每枚只能使用一次，请保存到独立密码管理器。")}</p>
        <ul>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
        <button className="rc-primary" type="button" onClick={acknowledgeRecoveryCodes}>{t("我已安全保存，从页面清除")}</button>
      </div> : null}
    </>}
  </section>;
}
