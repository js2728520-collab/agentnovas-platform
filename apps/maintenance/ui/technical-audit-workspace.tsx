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
  const [domain, setDomain] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState("");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      setDomain(params.get("domain") ?? "");
      setStatus(params.get("status") ?? "");
      setCursor(params.get("cursor") ?? "");
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const url = useMemo(() => {
    if (!ready) return null;
    const query = new URLSearchParams({ limit: "50" });
    if (domain) query.set("domain", domain);
    if (status) query.set("status", status);
    if (cursor) query.set("cursor", cursor);
    return `/api/maintenance/audit?${query}`;
  }, [cursor, domain, ready, status]);
  const resource = useApiData<AuditPage>(url, "技术审计读取失败");
  useEffect(() => {
    if (!ready) return;
    const query = new URLSearchParams();
    if (domain) query.set("domain", domain);
    if (status) query.set("status", status);
    if (cursor) query.set("cursor", cursor);
    window.history.replaceState(null, "", `/audit${query.size ? `?${query}` : ""}`);
  }, [cursor, domain, ready, status]);

  if (!ready || (resource.loading && !resource.data)) return <LoadingState label="正在读取技术审计…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const events = resource.data?.data ?? [];
  return <>
    <PageHeading
      eyebrow="TECHNICAL AUDIT"
      title="技术审计"
      description="统一展示模型、集成、设置、版本发布、安全、MFA 与 Demo 控制的安全投影；不会返回密钥、请求载荷、幂等键或 provider 订单标识。"
      actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button>}
    />
    <section className="rc-panel" aria-label="技术审计筛选">
      <div className="rc-filter-grid">
        <label>技术域<select value={domain} onChange={(event) => { setDomain(event.target.value); setCursor(""); }}><option value="">全部</option><option value="demo">Demo</option><option value="models">模型</option><option value="integrations">集成</option><option value="settings">设置</option><option value="releases">版本发布</option><option value="safety">安全停控</option><option value="identity">身份与 MFA</option></select></label>
        <label>状态<select value={status} onChange={(event) => { setStatus(event.target.value); setCursor(""); }}><option value="">全部</option><option value="pending">处理中</option><option value="succeeded">已完成</option><option value="failed">失败</option></select></label>
      </div>
    </section>
    {resource.loading && resource.data && <p className="rc-live" aria-live="polite">正在更新审计列表…</p>}
    {resource.error && resource.data && <div className="rc-live" role="alert">{resource.error}</div>}
    {!events.length ? <EmptyState title="暂无技术审计记录" description="所选技术域没有真实审计事件；系统不会生成演示记录。" /> : <div className="rc-card-list">
      {events.map((event) => <article className="rc-panel" key={event.id}>
        <header><div><small>{event.domain.toUpperCase()}</small><h2>{event.subject.label ?? `${event.subject.type} · ${event.subject.id}`}</h2><p>{event.action}</p></div><StatusBadge value={event.status} /></header>
        <dl className="rc-health-grid">
          <div><dt>执行人</dt><dd>{event.actorUserId ?? "system"}</dd></div>
          <div><dt>创建时间</dt><dd>{formatDateTime(event.createdAt)}</dd></div>
          <div><dt>完成时间</dt><dd>{formatDateTime(event.completedAt)}</dd></div>
          <div><dt>错误码</dt><dd>{event.errorCode ?? "—"}</dd></div>
          <div><dt>Request ID</dt><dd>{event.requestId ?? "—"}</dd></div>
          <div><dt>Trace ID</dt><dd>{event.traceId ?? "—"}</dd></div>
        </dl>
        <p><strong>原因：</strong>{event.reason ?? "未在安全投影中公开"}</p>
      </article>)}
    </div>}
    <div className="rc-heading-actions">
      {cursor && <button className="rc-button" type="button" onClick={() => setCursor("")}>返回第一页</button>}
      {resource.data?.page.nextCursor && <button className="rc-button" type="button" onClick={() => setCursor(resource.data!.page.nextCursor!)}>下一页</button>}
    </div>
  </>;
}
