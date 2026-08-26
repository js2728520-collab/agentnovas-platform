"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type SourceIntegration = {
  id: string;
  category: "market" | "news";
  name: string;
  description: string;
  implementationStatus: string;
  configured: boolean;
  hasSecret: boolean;
  configurationEnvKeys: string[];
  missingEnvKeys: string[];
  configurationMethod: "server_environment" | "none";
  enabled: boolean;
  health: string;
  lastTestStatus: string | null;
  lastErrorCode: string | null;
  lastLatencyMs: number | null;
  lastTestAt: string | null;
  testAvailable: boolean;
};

export function SourceIntegrationsWorkspace({ canTest }: { canTest: boolean }) {
  const resource = useApiData<{ integrations: SourceIntegration[] }>("/api/maintenance/integrations/catalog", "数据与新闻集成读取失败");
  const [reason, setReason] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function test(integration: SourceIntegration) {
    if (busy) return;
    setTestingId(integration.id);
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/maintenance/integrations/${encodeURIComponent(integration.id)}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "集成测试未通过"));
      setMessage(`${integration.name} 安全测试通过；该结果只证明固定只读端点当前可用。`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "集成测试未通过"); }
    finally { setBusy(false); setTestingId(null); }
  }

  if (resource.loading && !resource.data) return <LoadingState label="正在读取数据与新闻集成…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const integrations = resource.data?.integrations ?? [];
  return <>
    <PageHeading eyebrow="DATA SOURCES" title="数据与新闻集成" description="配置、启用、健康和陈旧状态分开显示。测试只访问代码固定的公共只读端点，不接受浏览器传入 URL。" actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>刷新</button>} />
    <div className="rc-live" aria-live="polite">{message}</div>
    {canTest ? <section className="rc-panel"><header><div><small>TEST AUDIT</small><h2>连通测试记录</h2><p>同一原因可连续测试多个固定只读数据源，无需重复弹窗。</p></div></header><div className="rc-form"><InlineAuditReasonField id="source-test-reason" value={reason} onChange={setReason} label="本轮测试原因" /></div></section> : null}
    {!integrations.length ? <EmptyState title="没有集成目录" description="系统未登记任何数据或新闻来源。" /> : <div className="rc-card-list">{integrations.map((integration) => <section className="rc-panel" key={integration.id}><header><div><small>{integration.category === "market" ? "MARKET DATA" : "NEWS"}</small><h2>{integration.name}</h2><p>{integration.description}</p></div><StatusBadge value={integration.health} /></header><dl className="rc-description-list"><div><dt>实现状态</dt><dd>{integration.implementationStatus}</dd></div><div><dt>configured</dt><dd>{integration.configured ? "yes" : "no"}</dd></div><div><dt>配置入口</dt><dd>{integration.configurationMethod === "server_environment" ? `服务端环境变量：${integration.configurationEnvKeys.join(", ")}` : "未登记"}</dd></div><div><dt>缺失配置</dt><dd>{integration.missingEnvKeys.length ? integration.missingEnvKeys.join(", ") : "无"}</dd></div><div><dt>enabled</dt><dd>{integration.enabled ? "yes" : "no"}</dd></div><div><dt>secret</dt><dd>{integration.hasSecret ? "存在（不可回显）" : integration.configured ? "无需密钥" : "未配置"}</dd></div><div><dt>最近测试</dt><dd>{formatDateTime(integration.lastTestAt)}</dd></div><div><dt>回执</dt><dd>{integration.lastTestStatus ?? "未测试"}{integration.lastLatencyMs !== null ? ` · ${integration.lastLatencyMs}ms` : ""}{integration.lastErrorCode ? ` · ${integration.lastErrorCode}` : ""}</dd></div></dl>{canTest && integration.testAvailable ? <button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(reason)} onClick={() => void test(integration)}>{testingId === integration.id ? "测试中…" : "执行安全测试"}</button> : <p className="rc-muted">{integration.testAvailable ? "当前账户无测试权限" : "尚未接入测试，不会显示假成功"}</p>}</section>)}</div>}
  </>;
}
