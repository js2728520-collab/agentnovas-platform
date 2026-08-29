"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { formatDateTime, type NotificationItem } from "@/packages/contracts/src/riverton-ui";
import { Icon } from "@/packages/ui/src/icon";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import { clientErrorMessage, clientRequest } from "./client-api";
import { presentClientNotification } from "./client-notification-presentation";
import styles from "./client-notifications.module.css";

export function ClientNotifications({ initialOpen = false }: { initialOpen?: boolean }) {
  const { locale, t } = useAppLocale();
  const [open, setOpen] = useState(initialOpen);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const [marking, setMarking] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const loadSummary = useCallback(async () => {
    try {
      const payload = await clientRequest<{ unread?: number }>("/api/notifications/inbox?summary=1", {}, t("通知读取失败"));
      setUnread(Number(payload.unread ?? 0));
    } catch {
      // 顶栏摘要失败不阻断其他页面；打开通知后会显示可重试的完整错误。
    }
  }, [t]);

  const load = useCallback(async () => {
    setState("loading");
    setMessage("");
    try {
      const payload = await clientRequest<{ notifications?: NotificationItem[]; unread?: number }>("/api/notifications/inbox", {}, t("通知读取失败"));
      setItems(Array.isArray(payload.notifications) ? payload.notifications.slice(0, 12) : []);
      setUnread(Number(payload.unread ?? 0));
      setState("ready");
    } catch (error) {
      setMessage(clientErrorMessage(error, t("通知读取失败")));
      setState("error");
    }
  }, [t]);

  useEffect(() => { const timer = window.setTimeout(() => void loadSummary(), 0); return () => window.clearTimeout(timer); }, [loadSummary]);
  useEffect(() => { if (!open) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeWithKeyboard);
    };
  }, [open]);

  async function markRead(id?: string) {
    if (marking) return;
    setMarking(id ?? "all");
    try {
      await clientRequest("/api/notifications/inbox", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(id ? { id } : { all: true }),
      }, t("标记失败"));
      await load();
    } catch (error) {
      setMessage(clientErrorMessage(error, t("标记失败")));
      setState("error");
    } finally {
      setMarking("");
    }
  }

  return <div className={styles.root} ref={rootRef}>
    <button
      ref={triggerRef}
      className={styles.trigger}
      type="button"
      title={t("通知")}
      aria-label={t("通知")}
      aria-expanded={open}
      aria-controls="client-notifications"
      onClick={() => setOpen((value) => !value)}
    ><Icon name="bell" />{unread > 0 && <span className={styles.badge} aria-label={`${unread} ${t("条未读")}`}>{unread > 99 ? "99+" : unread}</span>}</button>
    {open && <section id="client-notifications" className={styles.panel} role="dialog" aria-modal="false" aria-labelledby="client-notifications-title">
      <header><div><small>{t("最近通知")}</small><h2 id="client-notifications-title">{t("通知")}</h2></div>{unread > 0 && <button type="button" disabled={Boolean(marking)} onClick={() => void markRead()}>{marking === "all" ? t("处理中…") : t("全部已读")}</button>}</header>
      {state === "loading" || state === "idle" ? <p className={styles.state} role="status">{t("正在读取通知…")}</p>
        : state === "error" ? <div className={styles.state} role="alert"><p>{message}</p><button type="button" onClick={() => void load()}>{t("重新读取")}</button></div>
          : items.length === 0 ? <p className={styles.state} role="status">{t("暂无通知")}</p>
            : <div className={styles.list}>{items.map((item) => {
              const presentation = presentClientNotification(item, { locale, translate: t });
              return <article key={item.id} className={item.readAt ? styles.read : undefined}>
                <div><small>{presentation.category} · {formatDateTime(item.createdAt, locale)}</small><b>{presentation.title}</b><p>{presentation.detail}</p></div>
                {!item.readAt && <button type="button" disabled={Boolean(marking)} onClick={() => void markRead(item.id)}>{marking === item.id ? t("处理中…") : t("标为已读")}</button>}
              </article>;
            })}</div>}
      <footer><Link href="/settings?tab=notifications">{t("通知偏好")}</Link></footer>
    </section>}
  </div>;
}
