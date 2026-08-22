"use client";

import { useCallback, useEffect, useState } from "react";

import styles from "./client-notification-settings.module.css";
import { clientErrorMessage, clientRequest } from "./client-api";

const categories = [
  ["membership_billing", "会员缴费与到期", true],
  ["api_security", "API 与安全异常", true],
  ["risk_circuit_breaker", "风控熔断", true],
  ["trade_execution", "开仓和平仓", false],
  ["market_news", "行情与新闻", false],
] as const;
const channels = ["in_app", "email"] as const;
type Channel = typeof channels[number];
type Mode = "instant" | "digest" | "important_only" | "disabled";
type Preference = { category: string; channel: Channel | "telegram" | "whatsapp"; mode: Mode; quietStart?: string | null; quietEnd?: string | null };

export default function ClientNotificationSettings() {
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [busyKey, setBusyKey] = useState("");
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");
  const load = useCallback(async () => {
    setState("loading"); setMessage(""); setMessageKind("success");
    try {
      const payload = await clientRequest<{ preferences?: Preference[] }>("/api/notifications/preferences", {}, "通知偏好读取失败");
      const nextPreferences = Array.isArray(payload.preferences) ? payload.preferences : [];
      const scheduled = nextPreferences.find((item) => item.quietStart && item.quietEnd);
      setPreferences(nextPreferences);
      if (scheduled?.quietStart && scheduled.quietEnd) {
        setQuietStart(scheduled.quietStart);
        setQuietEnd(scheduled.quietEnd);
      }
      setState("ready");
    } catch (error) { setMessage(clientErrorMessage(error, "通知偏好读取失败")); setState("error"); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  function modeFor(category: string, channel: Channel): Mode {
    return preferences.find((item) => item.category === category && item.channel === channel)?.mode
      ?? (category === "market_news" ? "disabled" : "instant");
  }
  async function change(category: string, channel: Channel, mode: Mode) {
    const key = `${category}:${channel}`;
    if (busyKey) return;
    setBusyKey(key); setMessage(""); setMessageKind("success");
    try {
      await clientRequest<{ ok: boolean }>("/api/notifications/preferences", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ category, channel, mode, quietStart, quietEnd }),
      }, "通知偏好保存失败");
      setPreferences((current) => [...current.filter((item) => !(item.category === category && item.channel === channel)), { category, channel, mode, quietStart, quietEnd }]);
      setMessageKind("success");
      setMessage("通知偏好已保存");
    } catch (error) { setMessageKind("error"); setMessage(clientErrorMessage(error, "通知偏好保存失败，原设置保持不变")); }
    finally { setBusyKey(""); }
  }

  async function saveQuietHours() {
    if (busyKey) return;
    setBusyKey("quiet-hours"); setMessage(""); setMessageKind("success");
    try {
      await clientRequest<{ ok: boolean }>("/api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quietStart,
          quietEnd,
          preferences: categories.flatMap(([category]) => channels.map((channel) => ({
            category,
            channel,
            mode: modeFor(category, channel),
          }))),
        }),
      }, "免打扰时段保存失败");
      setPreferences((current) => current.map((item) => ({ ...item, quietStart, quietEnd })));
      setMessage("通知偏好与免打扰时段已保存");
    } catch (error) {
      setMessageKind("error");
      setMessage(clientErrorMessage(error, "免打扰时段保存失败，原设置保持不变"));
    } finally {
      setBusyKey("");
    }
  }

  return <section className={styles.settings} aria-labelledby="notification-settings-title">
    <div className={styles.widgetHead}><b id="notification-settings-title">通知渠道与偏好</b><span>安全通知不可关闭</span></div>
    <div className={styles.channelGrid} aria-label="外部通知渠道状态">
      {(["Telegram", "WhatsApp"] as const).map((name) => <article key={name}><b>{name}</b><span>当前版本未接入</span><em>not_integrated</em></article>)}
    </div>
    <p>当前仅站内与邮件偏好可配置。外部渠道不会展示连接入口、验证码或已发送状态。</p>
    <div className={styles.quietHours} aria-labelledby="quiet-hours-title">
      <div><b id="quiet-hours-title">免打扰时段</b><p>使用账号时区；安全与缴费通知仍会保留站内记录，并在时段结束后按渠道策略投递。</p></div>
      <label>开始<input type="time" value={quietStart} onChange={(event) => setQuietStart(event.target.value)} /></label>
      <label>结束<input type="time" value={quietEnd} onChange={(event) => setQuietEnd(event.target.value)} /></label>
      <button type="button" disabled={Boolean(busyKey) || !quietStart || !quietEnd} onClick={() => void saveQuietHours()}>{busyKey === "quiet-hours" ? "保存中…" : "保存时段"}</button>
    </div>
    {state === "loading" ? <p aria-live="polite">正在读取通知偏好…</p> : state === "error" ? <div role="alert"><p>{message}</p><button type="button" onClick={() => void load()}>重试</button></div> : <div className={styles.preferenceTable} role="table" aria-label="通知偏好">
      <header role="row"><b role="columnheader">通知类别</b><span role="columnheader">站内</span><span role="columnheader">邮件</span></header>
      {categories.map(([key, label, mandatory]) => <div key={key} role="row"><b role="rowheader">{label}{mandatory && <small>强制</small>}</b>{channels.map((channel) => {
        const controlKey = `${key}:${channel}`;
        return <span role="cell" key={channel}><select aria-label={`${label} · ${channel === "in_app" ? "站内" : "邮件"}`} value={modeFor(key, channel)} disabled={Boolean(busyKey)} onChange={(event) => void change(key, channel, event.target.value as Mode)}><option value="instant">即时</option><option value="digest">汇总</option><option value="important_only">仅重要</option>{!mandatory && <option value="disabled">关闭</option>}{busyKey === controlKey && <option value={modeFor(key, channel)}>保存中</option>}</select></span>;
      })}</div>)}
    </div>}
    {state !== "error" && message && <p role={messageKind === "error" ? "alert" : "status"} aria-live={messageKind === "error" ? "assertive" : "polite"}>{message}</p>}
  </section>;
}
