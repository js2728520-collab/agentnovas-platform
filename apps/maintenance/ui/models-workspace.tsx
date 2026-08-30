"use client";

import {
  AI_ROLE_CATALOG,
  createSecretEnvelope,
  type AiControlPlaneClient,
  type AiRoleKey,
  type ControlPlaneSnapshot,
} from "@agentnovas/ai-control-plane";
import { AiControlPlaneManager } from "@agentnovas/ai-control-plane-react";
import { useMemo,useState } from "react";

import { apiErrorMessage,formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { tradingHallAgentCatalog } from "@/packages/contracts/src/trading-hall";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { hasValidAuditReason,InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { ErrorState,LoadingState,PageHeading,StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type SnapshotResponse = {
  snapshot: ControlPlaneSnapshot;
  runtime: { gateway: string; research: string; runtimeExplanation: string };
};

type ConfigurationResult = {
  configuration: {
    connectionId: string;
    connectionRevisionId: string;
    deploymentId: string;
    deploymentRevisionId: string;
  };
};

async function jsonRequest<T>(url: string,init?: RequestInit): Promise<T> {
  const response = await fetch(url,init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(payload,"AI 控制面请求失败"));
  return payload as T;
}

async function fetchSnapshot() {
  return (await jsonRequest<SnapshotResponse>("/api/maintenance/ai-control-plane/snapshot",{
    cache: "no-store",
  })).snapshot;
}

const controlPlaneClient: AiControlPlaneClient = {
  snapshot: fetchSnapshot,
  refresh: fetchSnapshot,
};

const managerClasses = {
  root: "rc-control-plane",
  header: "rc-panel-heading",
  section: "rc-panel",
  list: "rc-card-list",
  item: "rc-control-plane-item",
  status: "rc-muted",
  empty: "rc-muted",
  error: "rc-callout",
};

function initialConfiguration() {
  return {
    connectionId: "",deploymentId: "",hasManagedSecret: false,
    connectionName: "",baseUrl: "",deploymentName: "",modelId: "",apiKey: "",
    contextWindow: "",maxOutputTokens: "",supportsStreaming: true,supportsStructuredOutput: false,
    rateCurrency: "USD",inputCostPerMillion: "",outputCostPerMillion: "",cachedInputCostPerMillion: "",
  };
}

export function ModelsWorkspace({ canManageProfiles,canManageBindings }: {
  canManageProfiles: boolean;
  canManageBindings: boolean;
}) {
  const { locale,t } = useAppLocale();
  const resource = useApiData<SnapshotResponse>(
    "/api/maintenance/ai-control-plane/snapshot",t("AI 控制面读取失败"),
  );
  const [form,setForm] = useState(initialConfiguration);
  const [reason,setReason] = useState("");
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const [managerVersion,setManagerVersion] = useState(0);
  const [bindingTargets,setBindingTargets] = useState<Record<string,string[]>>({});
  const [budget,setBudget] = useState({ scope: "platform",scopeId: "platform",period: "month",unit: "tokens",limit: "" });
  const snapshot = resource.data?.snapshot;

  async function refresh() {
    await resource.refresh();
    setManagerVersion((value) => value + 1);
  }

  async function mutate(operation: () => Promise<unknown>,success: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      await operation();
      setMessage(success);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("AI 控制面操作失败"));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfiguration() {
    const saved = await jsonRequest<ConfigurationResult>("/api/maintenance/ai-control-plane/configurations",{
      method: "POST",headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: form.connectionId || undefined,deploymentId: form.deploymentId || undefined,
        connectionName: form.connectionName,baseUrl: form.baseUrl,
        deploymentName: form.deploymentName,modelId: form.modelId,
        contextWindow: form.contextWindow || null,maxOutputTokens: form.maxOutputTokens || null,
        supportsStreaming: form.supportsStreaming,
        supportsStructuredOutput: form.supportsStructuredOutput,
        rateCurrency: form.inputCostPerMillion || form.outputCostPerMillion ? form.rateCurrency : "",
        inputCostPerMillion: form.inputCostPerMillion,outputCostPerMillion: form.outputCostPerMillion,
        cachedInputCostPerMillion: form.cachedInputCostPerMillion,reason: reason.trim(),
      }),
    });
    if (form.apiKey) {
      const key = await jsonRequest<{ key: { keyId: string;publicKeySpkiBase64: string } }>(
        "/api/maintenance/ai-control-plane/secret-key",{ cache: "no-store" },
      );
      const envelope = await createSecretEnvelope({
        commandId: crypto.randomUUID(),targetConnectionRevisionId: saved.configuration.connectionRevisionId,
        brokerKeyId: key.key.keyId,publicKeySpkiBase64: key.key.publicKeySpkiBase64,secret: form.apiKey,
      });
      await jsonRequest("/api/maintenance/ai-control-plane/secret-commands",{
        method: "POST",headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope,reason: reason.trim() }),
      });
    }
    setForm(initialConfiguration());
  }

  function prepareNewRevision(deployment: ControlPlaneSnapshot["deployments"][number]) {
    const connection = snapshot?.connections.find((item) => item.id === deployment.connectionId);
    setForm({
      connectionId: deployment.connectionId,deploymentId: deployment.id,
      hasManagedSecret: connection?.hasSecret === true,
      connectionName: connection?.name ?? "",baseUrl: "",deploymentName: deployment.name ?? "",
      modelId: deployment.modelId ?? "",apiKey: "",
      contextWindow: deployment.contextWindowTokens ? String(deployment.contextWindowTokens) : "",
      maxOutputTokens: deployment.maxOutputTokens ? String(deployment.maxOutputTokens) : "",
      supportsStreaming: deployment.supportsStreaming !== false,
      supportsStructuredOutput: deployment.supportsStructuredOutput === true,
      rateCurrency: deployment.rateCard?.currency ?? "USD",
      inputCostPerMillion: deployment.rateCard?.inputPerMillion ?? "",
      outputCostPerMillion: deployment.rateCard?.outputPerMillion ?? "",
      cachedInputCostPerMillion: deployment.rateCard?.cachedInputPerMillion ?? "",
    });
    setMessage(t("已载入当前非敏感配置；请重新填写公共 HTTPS 地址。API Key 留空会沿用当前受管 secretRef。"));
    document.getElementById("ai-control-plane-config-form")?.scrollIntoView({ behavior: "smooth",block: "start" });
  }

  function targetsFor(roleKey: AiRoleKey) {
    const pending = bindingTargets[roleKey];
    if (pending) return pending;
    const binding = snapshot?.bindings.find((item) => item.roleKey === roleKey);
    return [0,1,2].map((priority) => binding?.targets.find((item) => item.priority === priority)?.deploymentRevisionId ?? "");
  }

  function setTarget(roleKey: AiRoleKey,index: number,value: string) {
    setBindingTargets((current) => {
      const next = [...targetsFor(roleKey)];
      next[index] = value;
      if (!value) for (let cursor = index + 1; cursor < next.length; cursor += 1) next[cursor] = "";
      return { ...current,[roleKey]: next };
    });
  }

  const messages = useMemo(() => ({
    title: t("控制面资源"),refresh: t("刷新"),loading: t("正在更新"),error: t("读取失败"),
    empty: t("尚未配置"),connections: t("Provider Connections"),deployments: t("Model Deployments"),
    revisions: t("不可变修订与回滚"),
    bindings: t("12 个业务角色绑定"),probes: t("测试历史"),budgets: t("软预算"),
    enabled: t("已启用"),disabled: t("未启用"),primary: t("主模型"),fallback: t("回退"),current: t("当前修订"),
  }),[t]);

  if (resource.loading && !snapshot) return <LoadingState label={t("正在读取 AI 控制面…")} />;
  if (resource.error && !snapshot) return <ErrorState message={resource.error} retry={resource.refresh} />;
  if (!snapshot) return <ErrorState message={t("AI 控制面响应为空")} retry={resource.refresh} />;

  const readiness = {
    connections: snapshot.connections.filter((item) => item.hasSecret).length,
    deployments: snapshot.deployments.filter((item) => item.enabled).length,
    roles: snapshot.bindings.filter((item) => item.enabled && item.targets.length > 0).length,
    probes: snapshot.probes.filter((item) => item.status === "succeeded" && item.isExpired !== true).length,
  };

  return <>
    <PageHeading
      eyebrow="AI CONTROL PLANE"
      title={t("模型与 Agent")}
      description={t("连接、密钥托管、模型修订、12 个角色绑定、回退链、探测与预算使用同一控制面。浏览器和 Web 进程都不能读取模型密钥。")}
    />
    <div className="rc-live" aria-live="polite">{message}</div>
    <section className="rc-kpi-grid" aria-label={t("AI 控制面就绪度")}>
      <Metric label={t("已托管密钥连接")} value={`${readiness.connections} / ${snapshot.connections.length}`} />
      <Metric label={t("已激活部署")} value={`${readiness.deployments} / ${snapshot.deployments.length}`} />
      <Metric label={t("已配置角色")} value={`${readiness.roles} / 12`} />
      <Metric label={t("24 小时内有效测试")} value={String(readiness.probes)} />
    </section>
    <section className="rc-panel">
      <header><div><small>RUNTIME GATES</small><h2>{t("消费者运行状态")}</h2><p>{t("配置完成不等于消费者正在运行；各进程仍由独立开关控制。")}</p></div></header>
      <div className="rc-binding-grid">
        <RuntimeState label="AI Gateway" value={resource.data?.runtime.gateway ?? "disabled"} />
        <RuntimeState label="Research Worker" value={resource.data?.runtime.research ?? "retired"} />
        <RuntimeState label="Runtime explanation" value={resource.data?.runtime.runtimeExplanation ?? "gated"} />
      </div>
    </section>

    {(canManageProfiles || canManageBindings) && <section className="rc-panel">
      <header><div><small>CHANGE AUDIT</small><h2>{t("本轮配置原因")}</h2><p>{t("配置、密钥托管、测试、绑定和预算变更都把原因与资源修订在同一事务中记录。")}</p></div></header>
      <div className="rc-form"><InlineAuditReasonField id="ai-control-plane-reason" value={reason} onChange={setReason} label={t("配置与测试原因")} /></div>
    </section>}

    {canManageProfiles && <section className="rc-panel" id="ai-control-plane-config-form">
      <header><div><small>RECOVERABLE SETUP</small><h2>{t("新增连接与模型部署")}</h2><p>{t("保存后先生成不可变修订，再用 Broker 公钥在浏览器加密 API Key；Web 仅接收密文命令。")}</p></div></header>
      <div className="rc-form rc-form-grid">
        <label>{t("连接名称")}<input value={form.connectionName} maxLength={120} onChange={(event) => setForm({ ...form,connectionName: event.target.value })} /></label>
        <label>{t("公共 HTTPS 基础地址")}<input value={form.baseUrl} type="url" placeholder="https://api.example.com/v1" onChange={(event) => setForm({ ...form,baseUrl: event.target.value })} /></label>
        <label>{t("部署名称")}<input value={form.deploymentName} maxLength={120} onChange={(event) => setForm({ ...form,deploymentName: event.target.value })} /></label>
        <label>{t("模型 ID")}<input value={form.modelId} maxLength={200} onChange={(event) => setForm({ ...form,modelId: event.target.value })} /></label>
        <label>{t("上下文窗口 Token")}<input value={form.contextWindow} inputMode="numeric" onChange={(event) => setForm({ ...form,contextWindow: event.target.value.replace(/\D/g,"") })} /></label>
        <label>{t("单次最大输出 Token")}<input value={form.maxOutputTokens} inputMode="numeric" onChange={(event) => setForm({ ...form,maxOutputTokens: event.target.value.replace(/\D/g,"") })} /></label>
        <label>{t("Rate Card 币种")}<input value={form.rateCurrency} maxLength={8} onChange={(event) => setForm({ ...form,rateCurrency: event.target.value.toUpperCase().replace(/[^A-Z]/g,"") })} /></label>
        <label>{t("输入价格 / 百万 Token")}<input value={form.inputCostPerMillion} inputMode="decimal" placeholder={t("留空则标记 unpriced")} onChange={(event) => setForm({ ...form,inputCostPerMillion: event.target.value.replace(/[^\d.]/g,"").replace(/(\..*)\./g,"$1") })} /></label>
        <label>{t("输出价格 / 百万 Token")}<input value={form.outputCostPerMillion} inputMode="decimal" placeholder={t("留空则标记 unpriced")} onChange={(event) => setForm({ ...form,outputCostPerMillion: event.target.value.replace(/[^\d.]/g,"").replace(/(\..*)\./g,"$1") })} /></label>
        <label>{t("缓存输入价格 / 百万 Token")}<input value={form.cachedInputCostPerMillion} inputMode="decimal" placeholder={t("可选；缺省按输入价格")} onChange={(event) => setForm({ ...form,cachedInputCostPerMillion: event.target.value.replace(/[^\d.]/g,"").replace(/(\..*)\./g,"$1") })} /></label>
        <label>API Key（{t("仅在本机浏览器内加密")}）<input value={form.apiKey} type="password" autoComplete="new-password" maxLength={4096} placeholder={form.connectionId ? t("留空沿用受管密钥") : undefined} onChange={(event) => setForm({ ...form,apiKey: event.target.value })} /></label>
        <label className="rc-check"><input type="checkbox" checked={form.supportsStreaming} onChange={(event) => setForm({ ...form,supportsStreaming: event.target.checked })} />{t("支持流式输出")}</label>
        <label className="rc-check"><input type="checkbox" checked={form.supportsStructuredOutput} onChange={(event) => setForm({ ...form,supportsStructuredOutput: event.target.checked })} />{t("支持结构化输出")}</label>
      </div>
      <div className="rc-action-row"><button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(reason) || !form.connectionName || !form.baseUrl || !form.deploymentName || !form.modelId || (!form.hasManagedSecret && !form.apiKey) || Boolean(form.inputCostPerMillion) !== Boolean(form.outputCostPerMillion)} onClick={() => void mutate(saveConfiguration,form.apiKey ? t("配置修订与密钥托管命令已创建；Broker 处理完成后即可测试。") : t("新配置修订已创建并沿用当前受管密钥；请重新测试后再激活。"))}>{busy ? t("正在保存…") : form.connectionId ? t("保存为新修订") : t("保存并托管密钥")}</button></div>
    </section>}

    <AiControlPlaneManager
      key={`${managerVersion}:${snapshot.connections.length}:${snapshot.probes.length}`}
      client={controlPlaneClient}
      initialSnapshot={snapshot}
      roles={AI_ROLE_CATALOG}
      messages={messages}
      classNames={managerClasses}
      formatDateTime={(value) => formatDateTime(value,locale)}
      formatRateCard={(rate) => `${rate.currency} · ${t("输入")} ${rate.inputPerMillion}/1M · ${t("输出")} ${rate.outputPerMillion}/1M`}
      formatProbeDetails={(probe) => [
        ...(probe.phase ? [`${t("阶段")} ${probe.phase}`] : []),
        ...(probe.models?.length ? [`${t("发现模型")} ${probe.models.join(", ")}`] : []),
        ...(probe.errorCode ? [`${t("安全错误码")} ${probe.errorCode}`] : []),
      ]}
      renderDeploymentActions={canManageProfiles ? (deployment) => <div className="rc-action-row"><button className="rc-button" type="button" disabled={busy} onClick={() => prepareNewRevision(deployment)}>{t("创建新修订")}</button><button className="rc-button" type="button" disabled={busy || !deployment.currentRevisionId || !hasValidAuditReason(reason)} onClick={() => void mutate(
        () => jsonRequest("/api/maintenance/ai-control-plane/probes",{ method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify({ deploymentRevisionId: deployment.currentRevisionId,reason: reason.trim() }) }),
        t("连接、模型发现与最小调用测试已完成。"),
      )}>{t("测试当前修订")}</button></div> : undefined}
      renderDeploymentRevisionActions={canManageProfiles ? (revision) => revision.isCurrent ? null : <button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(reason)} onClick={() => void mutate(
        () => jsonRequest(`/api/maintenance/ai-control-plane/deployments/${encodeURIComponent(revision.deploymentId)}/revisions`,{ method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify({ sourceRevisionId: revision.id,expectedCurrentRevisionId: snapshot.deployments.find((item) => item.id === revision.deploymentId)?.currentRevisionId,reason: reason.trim() }) }),
        t("已从历史配置创建新的不可变回滚修订；重新测试后方可激活。"),
      )}>{t("回滚为新修订")}</button> : undefined}
    />

    {canManageBindings && <section className="rc-panel">
      <header><div><small>PRIMARY + TWO FALLBACKS</small><h2>{t("角色绑定与回退链")}</h2><p>{t("只对网络、超时、429 和 Provider 5xx 回退；认证、配置、校验、预算、权限与取消不会静默切换。")}</p></div></header>
      <div className="rc-card-list">{AI_ROLE_CATALOG.map((role) => {
        const targets = targetsFor(role.key);
        const binding = snapshot.bindings.find((item) => item.roleKey === role.key);
        return <article key={role.key}>
          <header><div><b>{t(role.label)}</b><small>{role.key} · {role.consumer}</small></div><StatusBadge value={binding?.runtimeState ?? role.runtimeState} /></header>
          <div className="rc-form rc-form-grid">
            {[t("主模型"),`${t("回退")} 1`,`${t("回退")} 2`].map((label,index) => <label key={label}>{label}<select value={targets[index]} disabled={busy || (index > 0 && !targets[index - 1])} onChange={(event) => setTarget(role.key,index,event.target.value)}><option value="">{t("不配置")}</option>{snapshot.deployments.map((deployment) => <option key={deployment.id} value={deployment.currentRevisionId ?? ""} disabled={!deployment.currentRevisionId}>{deployment.name} · {deployment.modelId ?? t("未知模型")}</option>)}</select></label>)}
          </div>
          <div className="rc-action-row"><button className="rc-button" type="button" disabled={busy || !targets[0] || !hasValidAuditReason(reason)} onClick={() => void mutate(
            () => jsonRequest("/api/maintenance/ai-control-plane/bindings",{ method: "PUT",headers: { "content-type": "application/json" },body: JSON.stringify({ roleKey: role.key,deploymentRevisionIds: targets.filter(Boolean),enabled: true,reason: reason.trim() }) }),
            t("角色绑定已生成新修订并激活。"),
          )}>{t("保存并激活")}</button></div>
        </article>;
      })}</div>
    </section>}

    {canManageProfiles && <section className="rc-panel">
      <header><div><small>OBSERVE ONLY</small><h2>{t("软预算策略")}</h2><p>{t("80% 与 100% 只生成 Maintenance 告警事实，不自动停用业务。")}</p></div></header>
      <div className="rc-form rc-form-grid">
        <label>{t("范围")}<select value={budget.scope} onChange={(event) => setBudget({ ...budget,scope: event.target.value })}><option value="platform">platform</option><option value="consumer">consumer</option><option value="role">role</option><option value="deployment">deployment</option><option value="organization">organization</option></select></label>
        <label>{t("范围标识")}<input value={budget.scopeId} maxLength={200} onChange={(event) => setBudget({ ...budget,scopeId: event.target.value })} /></label>
        <label>{t("周期")}<select value={budget.period} onChange={(event) => setBudget({ ...budget,period: event.target.value })}><option value="day">day</option><option value="month">month</option></select></label>
        <label>{t("单位")}<select value={budget.unit} onChange={(event) => setBudget({ ...budget,unit: event.target.value })}><option value="requests">requests</option><option value="tokens">tokens</option><option value="provider_cost">provider_cost</option><option value="platform_credits">platform_credits</option></select></label>
        <label>{t("上限（精确数值）")}<input value={budget.limit} inputMode="decimal" onChange={(event) => setBudget({ ...budget,limit: event.target.value.replace(/[^\d.]/g,"").replace(/(\..*)\./g,"$1") })} /></label>
      </div>
      <button className="rc-button" type="button" disabled={busy || !budget.limit || !budget.scopeId || !hasValidAuditReason(reason)} onClick={() => void mutate(
        () => jsonRequest("/api/maintenance/ai-control-plane/budgets",{ method: "PUT",headers: { "content-type": "application/json" },body: JSON.stringify({ ...budget,enabled: true,reason: reason.trim() }) }),
        t("软预算已保存；超限不会自动停业务。"),
      )}>{t("保存软预算")}</button>
    </section>}

    <section className="rc-panel"><header><div><small>DETERMINISTIC PRODUCT PIPELINE</small><h2>{t("七智能体确定性阶段目录")}</h2></div><StatusBadge value="simulation_only" /></header><p className="rc-muted">{t("七阶段仍是确定性、受硬风控约束的产品流程，不会变成任意 LLM 编排，也不会恢复真实永续订单路由。")}</p><div className="rc-card-list">{tradingHallAgentCatalog.map((agent) => <article key={agent.key}><header><div><b>{agent.sequence}. {t(agent.name)}</b><small>{agent.key}</small></div></header><p>{t(agent.question)}</p></article>)}</div></section>
  </>;
}

function Metric({ label,value }: { label: string;value: string }) {
  return <article><small>{label}</small><strong className="rc-kpi-status">{value}</strong></article>;
}

function RuntimeState({ label,value }: { label: string;value: string }) {
  return <article><div><b>{label}</b><small>{value}</small></div><StatusBadge value={value} /></article>;
}
