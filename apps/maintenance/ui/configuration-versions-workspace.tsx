"use client";

import { useRef, useState } from "react";

import type { ConfigurationActivationAction, ConfigurationApprovalDecision, ConfigurationTestResult } from "@/lib/versioned-configuration-domain";
import type { ConfigurationVersion, ConfigurationVersionsPayload } from "@/packages/contracts/src/versioned-configuration";
import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { ConfigurationVersionCreatePanel } from "./configuration-version-create-panel";
import { ConfigurationVersionDetailPanel } from "./configuration-version-detail-panel";
import { commandKey, shortHash } from "./configuration-version-ui";

function controlsStrategyResearch(version: ConfigurationVersion) {
  return version.kind === "feature_flag"
    && version.key === "client.strategy_research"
    && version.audience === "client"
    && [1, 2].includes(version.schemaVersion);
}

export function ConfigurationVersionsWorkspace(props: { currentUserId: string; canManage: boolean; canApprove: boolean; canActivate: boolean }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<ConfigurationVersionsPayload>("/api/maintenance/configuration-versions?limit=100", t("配置版本读取失败"));
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取配置版本与发布事实…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <ErrorState message={t("配置发布控制面不可用")} retry={resource.refresh} />;
  async function loadMore() {
    const cursor = resource.data?.nextCursor;
    if (!cursor || !resource.data || loadingMore) return;
    const current = resource.data;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const response = await fetch(`/api/maintenance/configuration-versions?limit=100&cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      const next = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = t("更早配置版本读取失败");
        const detail = apiErrorMessage(next, fallback);
        throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
      }
      const page = next as ConfigurationVersionsPayload;
      resource.setData({ versions: [...current.versions, ...page.versions], nextCursor: page.nextCursor });
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : t("更早配置版本读取失败"));
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
  const { locale, t } = useAppLocale();
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
    if (!response.ok) {
      const fallback = t("配置发布操作失败");
      const detail = apiErrorMessage(result, fallback);
      throw new Error(locale === "zh-CN" || !/[\u3400-\u9fff]/.test(detail) ? detail : fallback);
    }
    actionKeys.current.delete(name);
    return result;
  }

  async function runInline(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage("");
    try { await action(); setMessage(success); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : t("配置发布操作失败")); throw error; }
    finally { setBusy(false); }
  }

  async function createDraft(command: Record<string, unknown>) {
    await runInline(() => mutation("/api/maintenance/configuration-versions", command, "configuration-create"), t("不可变配置草稿已创建；后续修改需要创建新版本。"));
  }

  async function recordTest(version: ConfigurationVersion, result: ConfigurationTestResult, evidenceSha256: string) {
    await runInline(() => mutation(`/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}/tests`, { result, evidenceSha256 }, `configuration-test:${version.id}:${result}`), t("测试证据已登记；这不代表浏览器执行了自动测试。"));
  }

  async function runRegisteredTest(version: ConfigurationVersion) {
    await runInline(
      () => mutation(`/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}/tests`, {}, `configuration-family-test:${version.id}`),
      t("服务端确定性测试已通过，结果与证据已绑定到该不可变 payload。"),
    );
  }

  async function review(version: ConfigurationVersion, decision: ConfigurationApprovalDecision) {
    const base = `/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}`;
    await runInline(
      () => mutation(`${base}/approval`, { decision }, `configuration-approval:${version.id}:${decision}`),
      decision === "approve" ? t("独立审批已批准并记录。") : t("独立审批已拒绝并记录。"),
    );
  }

  async function schedule(version: ConfigurationVersion, scheduledFor: string) {
    const base = `/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}`;
    await runInline(
      () => mutation(`${base}/schedule`, { scheduledFor }, `configuration-schedule:${version.id}`),
      t("生效时间已按明确时区登记。"),
    );
  }

  async function activate(version: ConfigurationVersion, action: ConfigurationActivationAction) {
    const base = `/api/maintenance/configuration-versions/${encodeURIComponent(version.id)}`;
    const runtimeMessage = action === "activate"
      ? t("控制面 current 已切换；策略研究入口将在下一次请求按环境 Gate 与 current 功能开关共同判定。")
      : t("控制面已回滚；策略研究入口将在下一次请求按环境 Gate 与回滚版本共同判定。");
    await runInline(
      () => mutation(`${base}/activation`, { action }, `configuration-activation:${version.id}:${action}`),
      controlsStrategyResearch(version)
        ? runtimeMessage
        : action === "activate" ? t("控制面 current 已切换；该配置族尚未接管具体运行时消费者。") : t("控制面已回滚到所选历史版本；该配置族尚未接管具体运行时消费者。"),
    );
  }

  return <>
    <PageHeading eyebrow="VERSIONED CONFIGURATION CONTROL" title={t("配置发布")} description={t("管理非秘密配置的草稿、测试证据、独立审批、调度、激活与回滚。")} actions={<StatusBadge value={`${payload.versions.filter((version) => version.isCurrent).length} current`} />} />
    <div className="rc-callout" role="note"><code>client.strategy_research</code> {t("已接管 Client 策略研究入口，有效状态由环境 Gate 与 current 功能开关的全局或定向规则共同决定；其他配置族在接入消费者前仍只形成受审计的控制面投影。秘密和客户数据不得写入 payload。")}</div>
    <div className="rc-live" aria-live="polite">{message}</div>
    {canManage ? <ConfigurationVersionCreatePanel busy={busy} onCreate={createDraft} report={setMessage} /> : null}
    <section className="rc-panel">
      <header><div><small>APPEND-ONLY HISTORY</small><h2>{t("配置版本")}</h2></div><span>{payload.versions.length} {t("个版本")}</span></header>
      {!payload.versions.length ? <EmptyState title={t("尚无配置版本")} description={t("具备草稿管理权限的人员可创建第一个非秘密配置版本。")} /> : <div className="rc-card-grid">{payload.versions.map((version) => <article className="rc-card" key={version.id}>
        <header><StatusBadge value={version.status} /><time>{formatDateTime(version.createdAt, locale)}</time></header>
        <h3>{version.key} · v{version.versionNumber}</h3><p>{version.kind} / {version.audience} · schema {version.schemaVersion}</p>
        <dl><div><dt>Payload</dt><dd title={version.payloadSha256}>{shortHash(version.payloadSha256)}</dd></div><div><dt>{t("测试")}</dt><dd>{version.latestTest?.result ?? t("未登记")}</dd></div><div><dt>{t("计划")}</dt><dd>{version.schedule ? formatDateTime(version.schedule.scheduledFor, locale) : t("未安排")}</dd></div></dl>
        <footer className="rc-action-row"><button className="rc-button" type="button" aria-pressed={selected?.id === version.id} onClick={() => setSelectedId(version.id)}>{t("查看发布控制")}</button></footer>
      </article>)}</div>}
      {payload.nextCursor ? <div className="rc-action-row"><button className="rc-button" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("正在读取…") : t("加载更早版本")}</button></div> : null}
      {loadMoreError ? <div className="rc-live" role="alert">{loadMoreError}</div> : null}
    </section>
    {selected ? <ConfigurationVersionDetailPanel version={selected} current={current} currentUserId={currentUserId} canManage={canManage} canApprove={canApprove} canActivate={canActivate} busy={busy} onTest={(result, evidence) => recordTest(selected, result, evidence)} onRegisteredTest={() => runRegisteredTest(selected)} onReview={(decision) => review(selected, decision)} onSchedule={(scheduledFor) => schedule(selected, scheduledFor)} onActivation={(action) => activate(selected, action)} /> : null}
  </>;
}
