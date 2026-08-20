"use client";

import { useEffect, useState } from "react";

export default function VerifyEmailPage() {
  const [token] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") || "");
  const [message, setMessage] = useState(() => token ? "正在验证账号…" : "验证链接缺少令牌。");
  useEffect(() => {
    if (!token) return;
    void fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then(async response => {
      const result = await response.json() as { error?: string };
      setMessage(response.ok ? "账号验证成功，请返回登录。" : result.error || "验证链接无效或已过期");
    }).catch(() => setMessage("账号验证失败，请稍后重试。"));
  }, [token]);
  return <main style={{ maxWidth: 460, margin: "80px auto", padding: 24 }}>
    <h1>验证 AgentNovas 账号</h1>
    <p role="status">{message}</p>
  </main>;
}
