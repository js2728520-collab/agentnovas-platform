"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { AppAudience } from "@/lib/riverton-apps";
import { apiErrorMessage, safeNextPath } from "@/packages/contracts/src/riverton-ui";

type LoginMode = "login" | "register" | "forgot";
type MfaFlow =
  | { stage: "enroll"; setupKey: string }
  | { stage: "verify" }
  | { stage: "recovery"; recoveryCodes: string[] }
  | null;

function setupKeyFromUri(value: unknown) {
  try {
    const secret = new URL(String(value)).searchParams.get("secret")?.trim();
    return secret && /^[A-Z2-7]{16,128}$/i.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

export function AppLogin({ audience, title, description, allowRegistration, initialMode = "login" }: {
  audience: AppAudience;
  title: string;
  description: string;
  allowRegistration: boolean;
  initialMode?: LoginMode;
}) {
  const safeInitialMode = audience === "client" && initialMode === "forgot"
    ? "forgot"
    : allowRegistration && initialMode === "register" ? "register" : "login";
  const [mode, setMode] = useState<LoginMode>(safeInitialMode);
  const [mfaFlow, setMfaFlow] = useState<MfaFlow>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mfaCodeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mfaFlow?.stage === "enroll" || mfaFlow?.stage === "verify") {
      mfaCodeRef.current?.focus();
    }
  }, [mfaFlow?.stage]);

  function enterApplication() {
    const params = new URLSearchParams(window.location.search);
    window.location.assign(safeNextPath(params.get("next"), "/"));
  }

  async function postJson(endpoint: string, body: Record<string, unknown>) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(apiErrorMessage(payload, "操作失败，请稍后重试"));
    return payload;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mfaFlow?.stage === "recovery") return;
    setBusy(true);
    setMessage("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (mfaFlow?.stage === "enroll") {
        const result = await postJson("/api/auth/mfa/enroll/confirm", { code: values.code });
        const recoveryCodes = Array.isArray(result.recoveryCodes)
          ? result.recoveryCodes.filter((code): code is string => typeof code === "string" && code.length > 0)
          : [];
        if (recoveryCodes.length === 0) throw new Error("恢复码生成失败，请联系运维管理员");
        setMfaFlow({ stage: "recovery", recoveryCodes });
        return;
      }
      if (mfaFlow?.stage === "verify") {
        await postJson("/api/auth/mfa/verify", { code: values.code });
        enterApplication();
        return;
      }

      const endpoint = mode === "register"
        ? "/api/auth/register"
        : mode === "forgot" ? "/api/auth/forgot-password" : "/api/auth/login";
      const payload = await postJson(endpoint, values);
      if (mode === "login") {
        if (payload.mfaRequired === true) {
          if (audience === "client") throw new Error("当前客户端会话返回了无效的双重验证要求");
          if (payload.mfaEnrollmentRequired === true) {
            const enrollment = await postJson("/api/auth/mfa/enroll/start", {});
            const setupKey = setupKeyFromUri(enrollment.otpauthUri);
            if (!setupKey) throw new Error("双重验证设置密钥无效，请重新登录");
            setMfaFlow({ stage: "enroll", setupKey });
          } else {
            setMfaFlow({ stage: "verify" });
          }
          return;
        }
        enterApplication();
        return;
      }
      setMessage(apiErrorMessage(payload, mode === "forgot" ? "如果邮箱存在，重置邮件已进入发送队列" : "注册成功，请返回登录"));
      if (mode === "register") setMode("login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode: LoginMode) {
    setMode(nextMode);
    setMfaFlow(null);
    setMessage("");
  }

  const heading = mfaFlow?.stage === "enroll"
    ? "绑定双重验证"
    : mfaFlow?.stage === "verify" ? "双重验证"
      : mfaFlow?.stage === "recovery" ? "保存恢复码"
        : mode === "register" ? "创建客户账户" : mode === "forgot" ? "重置登录密码" : "安全登录";
  const helper = mfaFlow?.stage === "enroll"
    ? "将设置密钥加入身份验证器，再输入当前六位动态验证码。"
    : mfaFlow?.stage === "verify" ? "输入身份验证器动态验证码，或使用一枚尚未使用的恢复码。"
      : mfaFlow?.stage === "recovery" ? "恢复码仅显示一次。请保存到独立的安全位置后再进入应用。"
        : mode === "login" ? "请输入当前应用获授权的账户。"
          : mode === "forgot" ? "重置链接仅发送到已登记邮箱。" : "客户注册需要有效邀请码。";

  return <main className={`rc-auth rc-auth-${audience}`}>
    <section className="rc-auth-brand"><Link href="/">R</Link><div><small>{audience.toUpperCase()} ACCESS</small><h1>{title}</h1><p>{description}</p></div><ul><li>独立应用会话</li><li>服务端权限校验</li><li>完整操作审计</li></ul></section>
    <form onSubmit={submit} aria-labelledby="rc-login-heading">
      <header><small>RIVERTON CAPITAL</small><h2 id="rc-login-heading">{heading}</h2><p>{helper}</p></header>
      {!mfaFlow && mode === "register" && <><label>手机号<input name="phone" type="tel" autoComplete="tel" required /></label><label>邮箱（可选）<input name="email" type="email" autoComplete="email" /></label><label>邀请码<input name="invitationCode" required autoCapitalize="characters" /></label></>}
      {!mfaFlow && (mode === "forgot" ? <label>账户邮箱<input name="email" type="email" autoComplete="email" required /></label> : mode === "login" && <label>邮箱、手机号或用户名<input name="identifier" autoComplete="username" required /></label>)}
      {!mfaFlow && mode !== "forgot" && <label>密码<input name="password" type="password" minLength={10} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>}
      {mfaFlow?.stage === "enroll" && <label>身份验证器设置密钥<input className="rc-mfa-setup-key" value={mfaFlow.setupKey} readOnly aria-describedby="rc-mfa-setup-help" /></label>}
      {mfaFlow?.stage === "enroll" && <small id="rc-mfa-setup-help">设置密钥属于敏感信息；完成绑定后本页不会再次显示。</small>}
      {(mfaFlow?.stage === "enroll" || mfaFlow?.stage === "verify") && <label>{mfaFlow.stage === "enroll" ? "六位动态验证码" : "动态验证码或恢复码"}<input ref={mfaCodeRef} name="code" autoComplete="one-time-code" inputMode={mfaFlow.stage === "enroll" ? "numeric" : "text"} required /></label>}
      {mfaFlow?.stage === "recovery" && <div className="rc-recovery-codes" role="status" aria-live="polite"><ul>{mfaFlow.recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul><button className="rc-primary" type="button" onClick={enterApplication}>我已安全保存，进入应用</button></div>}
      {message && <div className="rc-auth-message" role="status" aria-live="polite">{message}</div>}
      {mfaFlow?.stage !== "recovery" && <button className="rc-primary" disabled={busy}>{busy ? "处理中…" : mfaFlow?.stage === "enroll" ? "绑定并生成恢复码" : mfaFlow?.stage === "verify" ? "验证并进入" : mode === "login" ? "登录" : mode === "forgot" ? "发送重置邮件" : "创建账户"}</button>}
      {!mfaFlow && <footer>
        {mode !== "login" && <button type="button" onClick={() => switchMode("login")}>返回登录</button>}
        {mode === "login" && audience === "client" && <button type="button" onClick={() => switchMode("forgot")}>忘记密码</button>}
        {mode === "login" && allowRegistration && <button type="button" onClick={() => switchMode("register")}>使用邀请码注册</button>}
      </footer>}
    </form>
  </main>;
}
