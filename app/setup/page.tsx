"use client";

import { FormEvent, useState } from "react";

export default function SetupPage() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("正在创建总公司超级管理员…");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/system/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-key": String(form.get("bootstrapKey") || ""),
        },
        body: JSON.stringify({
          email: String(form.get("email") || ""),
          password: String(form.get("password") || ""),
        }),
      });
      const data = (await response.json()) as { message?: string; error?: string };
      setMessage(data.message || data.error || "操作完成");
      if (response.ok) {
        event.currentTarget.reset();
        window.setTimeout(() => { window.location.href = "/"; }, 1800);
      }
    } catch {
      setMessage("无法连接服务器，请确认网站已启动。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 560, margin: "80px auto", padding: 24 }}>
      <section className="wide-panel">
        <p className="eyebrow">AGENTNOVAS ADMIN</p>
        <h1>初始化总公司超级管理员</h1>
        <p>本地开发可用此页面重置管理员密码；线上环境仅允许首次初始化。</p>
        <form onSubmit={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
          <label>管理员邮箱<input name="email" type="email" required placeholder="请输入管理员邮箱" autoComplete="email" /></label>
          <label>管理员密码<input name="password" type="password" minLength={10} required placeholder="至少 10 位" /></label>
          <label>初始化密钥<input name="bootstrapKey" type="password" required placeholder="请输入服务器中配置的初始化密钥" /></label>
          <button className="primary" disabled={busy}>{busy ? "正在处理…" : "创建超级管理员"}</button>
        </form>
        {message && <p className="admin-notice" style={{ marginTop: 16 }}>{message}</p>}
      </section>
    </main>
  );
}
