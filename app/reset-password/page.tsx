"use client";

import { useState, useSyncExternalStore } from "react";

function subscribeToResetToken(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

function readResetToken() {
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token") || "";
}

function getServerSnapshot() {
  return "";
}

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const token = useSyncExternalStore(subscribeToResetToken, readResetToken, getServerSnapshot);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const result = await response.json() as { error?: string };
    setMessage(response.ok ? "密码已更新，请返回登录。" : result.error || "重置链接无效或已过期");
  }
  return <main style={{ maxWidth: 460, margin: "80px auto", padding: 24 }}>
    <h1>重置 Riverton Capital 密码</h1>
    {!token ? <p>重置链接缺少令牌。</p> : <form onSubmit={submit}>
      <label style={{ display: "grid", gap: 8 }}><span>新密码</span><input type="password" minLength={10} required value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button type="submit" style={{ marginTop: 16 }}>更新密码</button>
    </form>}
    {message && <p role="status">{message}</p>}
  </main>;
}
