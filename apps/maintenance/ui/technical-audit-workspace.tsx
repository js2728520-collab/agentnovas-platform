"use client";

import { useEffect, useMemo, useState } from "react";

import { formatDateTime, type MaintenanceTechnicalAuditEvent } from "@/packages/contracts/src/riverton-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeading,
  StatusBadge,
} from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type AuditPage = {
  data: MaintenanceTechnicalAuditEvent[];
  page: { limit: number; nextCursor: string | null };
};

export function TechnicalAuditWorkspace() {
  const [ready, setReady] = useState(false);
  const [operation, setOperation] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      setOperation(params.get("operation") ?? "");
      setStatus(params.get("status") ?? "");
      setCursor(params.get("cursor") ?? "");
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const url = useMemo(() => {
    if (!ready) return null;
    const query = new URLSearchParams({ limit: "50" });
    if (operation) query.set("operation", operation);
    if (status) query.set("status", status);
    if (cursor) query.set("cursor", cursor);
    return `/api/maintenance/audit?${query}`;
  }, [cursor, operation, ready, status]);
  const resource = useApiData<AuditPage>(url, "技术审计读取失败");
  useEffect(() => {
    if (!ready) return;
    const query = new URLSearchParams();
    if (operation) query.set("operation", operation);
    if (status) query.set("status", status);
    if (cursor) query.set("cursor", cursor);
    window.history.replaceState(null, "", `/audit${query.size ? `?${query}` : ""}`);
  }, [cursor, operation, ready, status]);

  if (!ready || (resource.loading && !resource.data)) return <LoadingState label="正在读取技术审计…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const events = resource.data?.data ?? [];
  return <>
    <PageHeading
      eyebrow="TECHNICAL AUDIT"
      title="技术审计"
      description="只展示 Demo 控制与验证的安全投影；不会返回密钥、请求载荷、幂等键或 provider 订单标识。"
      actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button>}
    />
    <section className="rc-panel" aria-label="技术审计筛选">
      <div className="rc-filter-grid">
        <label>操作类型<select value={operation} onChange={(event) => { setOperation(event.target.value); setCursor(""); }}><option value="">全部</option><option value="control">安全控制</option><option value="verify">Provider 验证</option></select></label>
        <label>状态<select value={status} onChange={(event) => { setStatus(event.target.value); setCursor(""); }}><option value="">全部</option><option value="pending">处理中</option><option value="succeeded">已完成</option><option value="failed">失败</option></select></label>
      </div>
    </section>
    {resource.loading && resource.data && <p className="rc-live" aria-live="polite">正在更新审计列表…</p>}
    {resource.error && resource.data && <div className="rc-live" role="alert">{resource.error}</div>}
    {!events.length ? <EmptyState title="暂无技术审计记录" description="尚未执行 Demo 控制或验证；系统不会生成演示审计事件。" /> : <div className="rc-card-list">
      {events.map((event) => <article className="rc-panel" key={event.id}>
        <header><div><small>{event.operation === "verify" ? "PROVIDER VERIFY" : "SAFETY CONTROL"}</small><h2>{event.account.provider.toUpperCase()} · {event.account.label}</h2><p>{event.action}{event.strategyCode ? ` · ${event.strategyCode}` : ""}</p></div><StatusBadge value={event.status} /></header>
        <dl className="rc-health-grid">
          <div><dt>执行人</dt><dd>{event.actorUserId}</dd></div>
          <div><dt>创建时间</dt><dd>{formatDateTime(event.createdAt)}</dd></div>
          <div><dt>完成时间</dt><dd>{formatDateTime(event.completedAt)}</dd></div>
          <div><dt>错误码</dt><dd>{event.errorCode ?? "—"}</dd></div>
        </dl>
        <p><strong>原因：</strong>{event.reason}</p>
      </article>)}
    </div>}
    <div className="rc-heading-actions">
      {cursor && <button className="rc-button" type="button" onClick={() => setCursor("")}>返回第一页</button>}
      {resource.data?.page.nextCursor && <button className="rc-button" type="button" onClick={() => setCursor(resource.data!.page.nextCursor!)}>下一页</button>}
    </div>
  </>;
}
