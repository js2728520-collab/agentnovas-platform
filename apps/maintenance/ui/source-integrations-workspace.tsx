"use client";

import { useState } from "react";

import { apiErrorMessage, formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type SourceIntegration = {
  id: string;
  category: "market" | "news";
  name: string;
  description: string;
  implementationStatus: string;
  configured: boolean;
  hasSecret: boolean;
  enabled: boolean;
  health: string;
  lastTestStatus: string | null;
  lastErrorCode: string | null;
  lastLatencyMs: number | null;
  lastTestAt: string | null;
  testAvailable: boolean;
};

export function SourceIntegrationsWorkspace({ canTest }: { canTest: boolean }) {
  const { locale, t } = useAppLocale();
  const resource = useApiData<{ integrations: SourceIntegration[] }>("/api/maintenance/integrations/catalog", t("数据与新闻集成读取失败"));
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function test(integration: SourceIntegration) {
    if (busy) return;
    setTestingId(integration.id);
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/maintenance/integrations/${encodeURIComponent(integration.id)}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, t("集成测试未通过")));
      setMessage(`${integration.name} ${t("安全测试通过；该结果只证明固定只读端点当前可用。")}`);
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("集成测试未通过")); }
    finally { setBusy(false); setTestingId(null); }
  }

  if (resource.loading && !resource.data) return <LoadingState label={t("正在读取数据与新闻集成…")} />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const integrations = resource.data?.integrations ?? [];
  return <>
    <PageHeading eyebrow="DATA SOURCES" title={t("数据与新闻集成")} description={t("配置、启用、健康和陈旧状态分开显示。测试只访问代码固定的公共只读端点，不接受浏览器传入 URL。")} actions={<button className="rc-button" type="button" onClick={() => void resource.refresh()}>{t("刷新")}</button>} />
    <div className="rc-live" aria-live="polite">{message}</div>
    {!integrations.length ? <EmptyState title={t("没有集成目录")} description={t("系统未登记任何数据或新闻来源。")} /> : <div className="rc-card-list">{integrations.map((integration) => <section className="rc-panel" key={integration.id}><header><div><small>{integration.category === "market" ? "MARKET DATA" : "NEWS"}</small><h2>{integration.name}</h2><p>{t(integration.description)}</p></div><StatusBadge value={integration.health} /></header><dl className="rc-description-list"><div><dt>{t("实现状态")}</dt><dd>{integration.implementationStatus}</dd></div><div><dt>configured</dt><dd>{integration.configured ? "yes" : "no"}</dd></div><div><dt>enabled</dt><dd>{integration.enabled ? "yes" : "no"}</dd></div><div><dt>secret</dt><dd>{integration.hasSecret ? t("存在（不可回显）") : integration.configured ? t("无需密钥") : t("未配置")}</dd></div><div><dt>{t("最近测试")}</dt><dd>{formatDateTime(integration.lastTestAt, locale)}</dd></div><div><dt>{t("回执")}</dt><dd>{integration.lastTestStatus ?? t("未测试")}{integration.lastLatencyMs !== null ? ` · ${integration.lastLatencyMs}ms` : ""}{integration.lastErrorCode ? ` · ${integration.lastErrorCode}` : ""}</dd></div></dl>{canTest && integration.testAvailable ? <button className="rc-button" type="button" disabled={busy} onClick={() => void test(integration)}>{testingId === integration.id ? t("测试中…") : t("执行安全测试")}</button> : <p className="rc-muted">{integration.testAvailable ? t("当前账户无测试权限") : t("尚未接入测试，不会显示假成功")}</p>}</section>)}</div>}
  </>;
}
