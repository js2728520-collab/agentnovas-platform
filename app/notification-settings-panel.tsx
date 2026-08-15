"use client";

import { useEffect, useState } from "react";

const categories = [
  ["membership_billing", "会员缴费与到期", true],
  ["api_security", "API 与安全异常", true],
  ["risk_circuit_breaker", "风控熔断", true],
  ["trade_execution", "开仓和平仓", false],
  ["market_news", "行情与新闻", false],
] as const;

export default function NotificationSettingsPanel() {
  const [channels, setChannels] = useState<Array<Record<string, unknown>>>([]);
  const [preferences, setPreferences] = useState<Array<Record<string, unknown>>>([]);
  const [message, setMessage] = useState("");
  async function load() {
    const [channelResponse, preferenceResponse] = await Promise.all([fetch("/api/notifications/channels"), fetch("/api/notifications/preferences")]);
    if (channelResponse.ok) setChannels(((await channelResponse.json()).channels || []) as Array<Record<string, unknown>>);
    if (preferenceResponse.ok) setPreferences(((await preferenceResponse.json()).preferences || []) as Array<Record<string, unknown>>);
  }
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);
  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/notifications/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json() as { error?: string; message?: string; verificationCode?: string };
    setMessage(data.error || `${data.message || "已提交"}${data.verificationCode ? `，演示验证码：${data.verificationCode}` : ""}`);
    if (response.ok) void load();
  }
  async function change(category: string, channel: string, mode: string) {
    const response = await fetch("/api/notifications/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ category, channel, mode }) });
    const data = await response.json() as { error?: string };
    setMessage(data.error || "通知偏好已保存");
    if (response.ok) void load();
  }
  return <section className="notification-settings"><div className="widget-head"><b>通知渠道与偏好</b><span>行情新闻默认关闭</span></div><div className="channel-grid"><form onSubmit={connect}><select name="channel"><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option></select><input name="destination" required placeholder="账号或手机号码"/><button className="primary">连接渠道</button></form>{["telegram", "whatsapp"].map(name => { const row = channels.find(item => item.channel === name); return <article key={name}><b>{name === "telegram" ? "Telegram" : "WhatsApp"}</b><span>{String(row?.destination || "未连接")}</span><em>{row?.status === "verified" ? "已验证" : row ? "等待验证" : "未连接"}</em></article>; })}</div>{message && <p>{message}</p>}<div className="preference-table"><header><b>通知类别</b><span>站内</span><span>邮件</span><span>Telegram</span><span>WhatsApp</span></header>{categories.map(([key, label, mandatory]) => <div key={key}><b>{label}{mandatory && <small>强制</small>}</b>{["in_app", "email", "telegram", "whatsapp"].map(channel => { const preference = preferences.find(item => item.category === key && item.channel === channel); const defaultMode = key === "market_news" ? "disabled" : "instant"; return <select key={channel} value={String(preference?.mode || defaultMode)} onChange={event => void change(key, channel, event.target.value)}><option value="instant">即时</option><option value="digest">汇总</option><option value="important_only">仅重要</option>{!mandatory && <option value="disabled">关闭</option>}</select>; })}</div>)}</div></section>;
}
