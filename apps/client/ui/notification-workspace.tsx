"use client";

import { useCallback, useEffect, useState } from "react";

import NotificationSettingsPanel from "@/app/notification-settings-panel";
import { apiErrorMessage, formatDateTime, type EffectiveAccessPayload, type NotificationItem, type ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";

import { ClientPortalShell } from "./client-portal-shell";

export function NotificationWorkspace({ viewer, access }: { viewer: ViewerPayload; access: EffectiveAccessPayload }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setState("loading");
    try { const response = await fetch("/api/notifications/inbox", { cache: "no-store" }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(apiErrorMessage(payload, "通知读取失败")); setItems(Array.isArray(payload.notifications) ? payload.notifications : []); setUnread(Number(payload.unread || 0)); setState("ready"); }
    catch (caught) { setMessage(caught instanceof Error ? caught.message : "通知读取失败"); setState("error"); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function markRead(id?: string) {
    const response = await fetch("/api/notifications/inbox", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { id } : { all: true }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(apiErrorMessage(payload, "标记失败")); return; }
    setMessage(id ? "通知已标记为已读" : "全部通知已标记为已读"); await load();
  }
  return <ClientPortalShell viewer={viewer} access={access}>
    <PageHeading eyebrow="CLIENT NOTIFICATIONS" title="通知中心" description="安全、缴费和风控通知不可关闭；外部渠道需完成验证后才会使用。" actions={unread > 0 ? <button className="rc-button" onClick={() => void markRead()}>全部已读</button> : undefined} />
    {message && <div className="rc-callout" role="status" aria-live="polite">{message}</div>}
    <section className="rc-panel"><header><div><small>INBOX</small><h2>站内通知</h2></div><StatusBadge value={`${unread} 条未读`} /></header>{state === "loading" ? <LoadingState /> : state === "error" ? <ErrorState message={message} retry={() => void load()} /> : !items.length ? <EmptyState title="暂无通知" description="账户安全、会员和策略生命周期消息会显示在这里。" /> : <div className="rc-notification-list">{items.map((item) => <article key={item.id} className={item.readAt ? "is-read" : ""}><div><small>{item.category} · {formatDateTime(item.createdAt)}</small><b>{item.templateKey}</b><p>{Object.entries(item.payload).slice(0, 3).map(([key, value]) => `${key}: ${String(value)}`).join(" · ") || "通知详情已安全保存"}</p></div><div><StatusBadge value={item.status} />{!item.readAt && <button type="button" onClick={() => void markRead(item.id)}>标为已读</button>}</div></article>)}</div>}</section>
    <NotificationSettingsPanel />
  </ClientPortalShell>;
}
