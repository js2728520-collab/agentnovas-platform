"use client";

import { useState } from "react";
import Link from "next/link";

import { apiErrorMessage, safeNextPath } from "@/packages/contracts/src/riverton-ui";
import type { AppAudience } from "@/lib/riverton-apps";

type LoginMode = "login" | "register" | "forgot";

export function AppLogin({ audience, title, description, allowRegistration, initialMode = "login" }: { audience: AppAudience; title: string; description: string; allowRegistration: boolean; initialMode?: LoginMode }) {
  const safeInitialMode = audience === "client" && initialMode === "forgot"
    ? "forgot"
    : allowRegistration && initialMode === "register" ? "register" : "login";
  const [mode, setMode] = useState<LoginMode>(safeInitialMode);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const endpoint = mode === "register" ? "/api/auth/register" : mode === "forgot" ? "/api/auth/forgot-password" : "/api/auth/login";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(values) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "操作失败，请稍后重试"));
      if (mode === "login") {
        const params = new URLSearchParams(window.location.search);
        window.location.assign(safeNextPath(params.get("next"), "/"));
      } else {
        setMessage(apiErrorMessage(payload, mode === "forgot" ? "如果邮箱存在，重置邮件已进入发送队列" : "注册成功，请返回登录"));
        if (mode === "register") setMode("login");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  const heading = mode === "register" ? "创建客户账户" : mode === "forgot" ? "重置登录密码" : "安全登录";
  return <main className={`rc-auth rc-auth-${audience}`}>
    <section className="rc-auth-brand"><Link href="/">R</Link><div><small>{audience.toUpperCase()} ACCESS</small><h1>{title}</h1><p>{description}</p></div><ul><li>独立应用会话</li><li>服务端权限校验</li><li>完整操作审计</li></ul></section>
    <form onSubmit={submit} aria-labelledby="rc-login-heading">
      <header><small>RIVERTON CAPITAL</small><h2 id="rc-login-heading">{heading}</h2><p>{mode === "login" ? "请输入当前应用获授权的账户。" : mode === "forgot" ? "重置链接仅发送到已登记邮箱。" : "客户注册需要有效邀请码。"}</p></header>
      {mode === "register" && <><label>手机号<input name="phone" type="tel" autoComplete="tel" required /></label><label>邮箱（可选）<input name="email" type="email" autoComplete="email" /></label><label>邀请码<input name="invitationCode" required autoCapitalize="characters" /></label></>}
      {mode === "forgot" ? <label>账户邮箱<input name="email" type="email" autoComplete="email" required /></label> : mode === "login" && <label>邮箱、手机号或用户名<input name="identifier" autoComplete="username" required /></label>}
      {mode !== "forgot" && <label>密码<input name="password" type="password" minLength={10} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>}
      {message && <div className="rc-auth-message" role="status" aria-live="polite">{message}</div>}
      <button className="rc-primary" disabled={busy}>{busy ? "处理中…" : mode === "login" ? "登录" : mode === "forgot" ? "发送重置邮件" : "创建账户"}</button>
      <footer>
        {mode !== "login" && <button type="button" onClick={() => { setMode("login"); setMessage(""); }}>返回登录</button>}
        {mode === "login" && audience === "client" && <button type="button" onClick={() => { setMode("forgot"); setMessage(""); }}>忘记密码</button>}
        {mode === "login" && allowRegistration && <button type="button" onClick={() => { setMode("register"); setMessage(""); }}>使用邀请码注册</button>}
      </footer>
    </form>
  </main>;
}
