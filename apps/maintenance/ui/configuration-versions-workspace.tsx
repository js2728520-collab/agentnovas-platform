"use client";

import { useRef, useState } from "react";

import type { ConfigurationActivationAction, ConfigurationApprovalDecision, ConfigurationTestResult } from "@/lib/versioned-configuration-domain";
import type { ConfigurationVersion, ConfigurationVersionsPayload } from "@/packages/contracts/src/versioned-configuration";
import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { ConfigurationVersionCreatePanel } from "./configuration-version-create-panel";
import { ConfigurationVersionDetailPanel } from "./configuration-version-detail-panel";
import { commandKey, shortHash } from "./configuration-version-ui";

export function ConfigurationVersionsWorkspace(props: { currentUserId: string; canManage: boolean; canApprove: boolean; canActivate: boolean }) {
  const resource = useApiData<ConfigurationVersionsPayload>("/api/maintenance/configuration-versions?limit=100", "配置版本读取失败");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  if (resource.loading && !resource.data) return <LoadingState label="正在读取配置版本与发布事实…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message="配置发布控制面不可用" retry={resource.refresh} />;
  async function loadMore() {
    const cursor = resource.data?.nextCursor;
    if (!cursor || !resource.data || loadingMore) return;
    const current = resource.data;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const response = await fetch(`/api/maintenance/configuration-versions?limit=100&cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      const next = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(next, "更早配置版本读取失败"));
      const page = next as ConfigurationVersionsPayload;
      resource.setData({ versions: [...current.versions, ...page.versions], nextCursor: page.nextCursor });
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : "更早配置版本读取失败");
    } finally {
      setLoadingMore(false);
    }
  }
  return <ConfigurationVersionsControl {...props} payload={resource.data} refresh={resource.refresh} loadingMore={loadingMore} loadMoreError={loadMoreError} loadMore={loadMore} />;
}

function ConfigurationVersionsControl({ payload, refresh, currentUserId, canManage, canApprove, canActivate, loadingMore, loadMoreError, loadMore }: {
  payload: ConfigurationVersionsPayload;
  refresh: () => Promise<void>;
  currentUserId: string;
  canManage: boolean;
  canApprove: boolean;
  canActivate: boolean;
  loadingMore: boolean;
  loadMoreError: string;
  loadMore: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(payload.versions[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const actionKeys = useRef(new Map<string, string>());
  const selected = payload.versions.find((version) => version.id === selectedId) ?? payload.versions[0] ?? null;
  const current = selected ? payload.versions.find((version) => version.isCurrent && version.kind === selected.kind && version.key === selected.key && version.audience === selected.audience) ?? null : null;

  async function mutation(path: string, body: Record<string, unknown>, name: string) {
    const key = actionKeys.current.get(name) ?? commandKey(name);
    actionKeys.current.set(name, key);
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiErrorMessage(result, "配置发布操作失败"));
    actionKeys.current.delete(name);
    return result;
  }

  async function runInline(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage("");
    try { await action(); setMessage(success); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "配置发布操作失败"); throw error; }
    finally { setBusy(false); }
  }

  async function createDraft(command: Record<string, unknown>) {
    await runInline(() => mutation("/api/maintenance/configuration-versions", command, "configuration-create"), "不可变配置草稿已创建；后续修改需要创建新版本。");
  }

  async function recordTest(version: ConfigurationVersion, result: ConfigurationTestResult, evidenceSha256: string, reason: string) {
    await runInline(() => mutation(`/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}/tests`, { result, evidenceSha256, reason }, `configuration-test:${version.id}:${result}`), "测试证据已登记；这不代表浏览器执行了自动测试。");
  }

  async function review(version: ConfigurationVersion, decision: ConfigurationApprovalDecision, reason: string) {
    const base = `/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}`;
    await runInline(
      () => mutation(`${base}/approval`, { decision, reason }, `configuration-approval:${version.id}:${decision}`),
      decision === "approve" ? "独立审批已批准并记录。" : "独立审批已拒绝并记录。",
    );
  }

  async function schedule(version: ConfigurationVersion, scheduledFor: string, reason: string) {
    const base = `/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}`;
    await runInline(
      () => mutation(`${base}/schedule`, { scheduledFor, reason }, `configuration-schedule:${version.id}`),
      "生效时间已按明确时区登记。",
    );
  }

  async function activate(version: ConfigurationVersion, action: ConfigurationActivationAction, reason: string) {
    const base = `/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}`;
    await runInline(
      () => mutation(`${base}/activation`, { action, reason }, `configuration-activation:${version.id}:${action}`),
      action === "activate" ? "控制面 current 已切换；尚未接管具体运行时消费者。" : "控制面已回滚到所选历史版本；尚未接管具体运行时消费者。",
    );
  }

  return <>
    <PageHeading eyebrow="VERSIONED CONFIGURATION CONTROL" title="配置发布" description="管理非秘密配置的草稿、测试证据、独立审批、调度、激活与回滚。" actions={<StatusBadge value={`${payload.versions.filter((version) => version.isCurrent).length} current`} />} />
    <div className="rc-callout" role="note">通用配置发布框架尚未接管具体运行时；active 目前只代表受审计的控制面 current 投影。秘密和客户数据不得写入 payload。</div>
    <div className="rc-live" aria-live="polite">{message}</div>
    {canManage ? <ConfigurationVersionCreatePanel busy={busy} onCreate={createDraft} report={setMessage} /> : null}
    <section className="rc-panel">
      <header><div><small>APPEND-ONLY HISTORY</small><h2>配置版本</h2></div><span>{payload.versions.length} 个版本</span></header>
      {!payload.versions.length ? <EmptyState title="尚无配置版本" description="具备草稿管理权限的人员可创建第一个非秘密配置版本。" /> : <div className="rc-card-grid">{payload.versions.map((version) => <article className="rc-card" key={version.id}>
        <header><StatusBadge value={version.status} /><time>{formatDateTime(version.createdAt)}</time></header>
        <h3>{version.key} · v{version.versionNumber}</h3><p>{version.kind} / {version.audience} · schema {version.schemaVersion}</p>
        <dl><div><dt>Payload</dt><dd title={version.payloadSha256}>{shortHash(version.payloadSha256)}</dd></div><div><dt>测试</dt><dd>{version.latestTest?.result ?? "未登记"}</dd></div><div><dt>计划</dt><dd>{version.schedule ? formatDateTime(version.schedule.scheduledFor) : "未安排"}</dd></div></dl>
        <footer className="rc-action-row"><button className="rc-button" type="button" aria-pressed={selected?.id === version.id} onClick={() => setSelectedId(version.id)}>查看发布控制</button></footer>
      </article>)}</div>}
      {payload.nextCursor ? <div className="rc-action-row"><button className="rc-button" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : "加载更早版本"}</button></div> : null}
      {loadMoreError ? <div className="rc-live" role="alert">{loadMoreError}</div> : null}
    </section>
    {selected ? <ConfigurationVersionDetailPanel version={selected} current={current} currentUserId={currentUserId} canManage={canManage} canApprove={canApprove} canActivate={canActivate} busy={busy} onTest={(result, evidence, reason) => recordTest(selected, result, evidence, reason)} onReview={(decision, reason) => review(selected, decision, reason)} onSchedule={(scheduledFor, reason) => schedule(selected, scheduledFor, reason)} onActivation={(action, reason) => activate(selected, action, reason)} /> : null}
  </>;
}
