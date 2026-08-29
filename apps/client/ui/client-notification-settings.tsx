"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import styles from "./client-notification-settings.module.css";
import { clientErrorMessage, clientRequest } from "./client-api";
import { notificationQuietHoursPayload, resolveNotificationQuietHours } from "./client-notification-preferences-model";

const categories = [
  ["membership_billing", "会员缴费与到期", true],
  ["api_security", "账户与安全", true],
  ["risk_circuit_breaker", "风险提醒", true],
  ["trade_execution", "模拟交易", false],
  ["market_news", "行情与新闻", false],
] as const;
const channels = ["in_app", "email"] as const;
type Channel = typeof channels[number];
type Mode = "instant" | "digest" | "important_only" | "disabled";
type Preference = { category: string; channel: Channel; mode: Mode; quietStart?: string | null; quietEnd?: string | null };
type PreferenceModes = Record<string, Mode>;

const modeOptions = [
  ["instant", "即时"],
  ["digest", "汇总"],
  ["important_only", "仅重要"],
] as const;

function preferenceKey(category: string, channel: Channel) {
  return `${category}:${channel}`;
}

function defaultModes(): PreferenceModes {
  return Object.fromEntries(categories.flatMap(([category]) => channels.map((channel) => [
    preferenceKey(category, channel),
    category === "market_news" ? "disabled" : "instant",
  ]))) as PreferenceModes;
}

export default function ClientNotificationSettings() {
  const { t } = useAppLocale();
  const [modes, setModes] = useState<PreferenceModes>(defaultModes);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [saving, setSaving] = useState(false);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");

  const load = useCallback(async () => {
    setState("loading");
    setMessage("");
    setMessageKind("success");
    try {
      const payload = await clientRequest<{ preferences?: Preference[] }>("/api/notifications/preferences", {}, t("通知偏好读取失败"));
      const preferences = Array.isArray(payload.preferences) ? payload.preferences : [];
      const nextModes = defaultModes();
      for (const preference of preferences) {
        if (channels.includes(preference.channel) && categories.some(([category]) => category === preference.category)) {
          nextModes[preferenceKey(preference.category, preference.channel)] = preference.mode;
        }
      }
      const quietHours = resolveNotificationQuietHours(preferences);
      setModes(nextModes);
      setQuietEnabled(quietHours.enabled);
      setQuietStart(quietHours.start);
      setQuietEnd(quietHours.end);
      setState("ready");
    } catch (error) {
      setMessage(clientErrorMessage(error, t("通知偏好读取失败")));
      setState("error");
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || state !== "ready") return;
    setSaving(true);
    setMessage("");
    setMessageKind("success");
    try {
      const quietHours = notificationQuietHoursPayload(quietEnabled, quietStart, quietEnd);
      await clientRequest<{ ok: boolean }>("/api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...quietHours,
          preferences: categories.flatMap(([category]) => channels.map((channel) => ({
            category,
            channel,
            mode: modes[preferenceKey(category, channel)],
          }))),
        }),
      }, t("通知设置保存失败"));
      setMessage(t("通知设置已保存"));
    } catch (error) {
      setMessageKind("error");
      setMessage(clientErrorMessage(error, t("通知设置保存失败，原设置保持不变")));
    } finally {
      setSaving(false);
    }
  }

  if (state === "loading") return <section className={styles.panel} aria-live="polite" aria-busy="true"><p className={styles.loading}>{t("正在读取通知设置…")}</p></section>;
  if (state === "error") return <section className={styles.panel} role="alert"><p className={styles.error}>{message}</p><button className={styles.secondaryButton} type="button" onClick={() => void load()}>{t("重新读取")}</button></section>;

  return <form className={styles.form} onSubmit={(event) => void save(event)}>
    <section className={styles.panel} aria-labelledby="quiet-hours-title">
      <div className={styles.sectionHeading}><div><h2 id="quiet-hours-title">{t("免打扰时段")}</h2><p>{t("开启后按账号时区生效；重要通知仍会保留在站内。")}</p></div></div>
      <div className={styles.quietToggle}><input id="notification-quiet-enabled" type="checkbox" checked={quietEnabled} disabled={saving} onChange={(event) => setQuietEnabled(event.target.checked)} /><label htmlFor="notification-quiet-enabled"><strong>{t("启用免打扰")}</strong><small>{t(quietEnabled ? "时段内暂停普通通知投递" : "当前按各通知类型设置正常投递")}</small></label></div>
      <div className={styles.timeFields}>
        <label htmlFor="notification-quiet-start"><span>{t("开始时间")}</span><input id="notification-quiet-start" type="time" value={quietStart} disabled={saving || !quietEnabled} onChange={(event) => setQuietStart(event.target.value)} /></label>
        <label htmlFor="notification-quiet-end"><span>{t("结束时间")}</span><input id="notification-quiet-end" type="time" value={quietEnd} disabled={saving || !quietEnabled} onChange={(event) => setQuietEnd(event.target.value)} /></label>
      </div>
    </section>

    <section className={styles.panel} aria-labelledby="notification-types-title">
      <div className={styles.sectionHeading}><div><h2 id="notification-types-title">{t("通知类型")}</h2><p>{t("分别设置站内和邮件的接收方式。")}</p></div></div>
      <div className={styles.preferenceHeader} aria-hidden="true"><span>{t("类型")}</span><span>{t("站内")}</span><span>{t("邮件")}</span></div>
      <div className={styles.preferenceList}>
        {categories.map(([category, label, mandatory]) => <div className={styles.preferenceRow} role="group" aria-labelledby={`notification-category-${category}`} key={category}>
          <div className={styles.categoryLabel} id={`notification-category-${category}`}><strong>{t(label)}</strong>{mandatory && <small>{t("始终保留")}</small>}</div>
          {channels.map((channel) => <label className={styles.channelControl} key={channel}>
            <span>{t(channel === "in_app" ? "站内" : "邮件")}</span>
            <select
              aria-label={`${t(label)} · ${t(channel === "in_app" ? "站内" : "邮件")}`}
              value={modes[preferenceKey(category, channel)]}
              disabled={saving}
              onChange={(event) => setModes((current) => ({ ...current, [preferenceKey(category, channel)]: event.target.value as Mode }))}
            >
              {modeOptions.map(([value, text]) => <option value={value} key={value}>{t(text)}</option>)}
              {!mandatory && <option value="disabled">{t("关闭")}</option>}
            </select>
          </label>)}
        </div>)}
      </div>
    </section>

    <div className={styles.formActions}>
      <button className={styles.primaryButton} type="submit" disabled={saving || (quietEnabled && (!quietStart || !quietEnd))}>{t(saving ? "保存中…" : "保存通知设置")}</button>
      {message && <p className={messageKind === "error" ? styles.error : styles.success} role={messageKind === "error" ? "alert" : "status"} aria-live={messageKind === "error" ? "assertive" : "polite"}>{message}</p>}
    </div>
  </form>;
}
