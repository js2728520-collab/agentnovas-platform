"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime, type MaintenanceAgentBinding, type MaintenanceModelProfile } from "@/packages/contracts/src/riverton-ui";
import { hasValidAuditReason, InlineAuditReasonField } from "@/packages/ui/src/inline-audit-reason-field";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { tradingHallAgentCatalog } from "@/packages/contracts/src/trading-hall";

type ConfigurationAction = { kind: "profile" }
  | { kind: "binding"; role: string; profileId: string; runtime: boolean; enabled: boolean }
  | { kind: "test"; role: string; runtime: boolean };
type RollbackAction = { kind: "rollback"; profileId: string; revisionId: string; expectedCurrentRevisionId: string };
type RevisionView = { id: string; revisionNumber: number; name: string; providerName: string; modelName: string; hasSecret: boolean; enabled: boolean; isCurrent: boolean; createdByUserId: string; createdAt: string };

export function ModelsWorkspace({ canManageProfiles, canManageBindings }: { canManageProfiles: boolean; canManageBindings: boolean }) {
  const profiles = useApiData<{ profiles: MaintenanceModelProfile[] }>("/api/admin/llm-profiles", "模型 Profile 读取失败");
  const research = useApiData<{ bindings: MaintenanceAgentBinding[] }>("/api/admin/agent-role-bindings", "Research Agent 绑定读取失败");
  const runtime = useApiData<{ bindings: MaintenanceAgentBinding[] }>("/api/admin/runtime-explanation-bindings", "Runtime Agent 绑定读取失败");
  const [form, setForm] = useState({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true });
  // 探测结果。流程是「填地址和密钥 → 测试 → 从返回的列表里挑模型 → 保存」，
  // 而不是「盲填模型名 → 保存 → 绑到生产角色 → 才知道对不对」。
  const presets = useApiData<{ presets: { id: string; label: string; baseUrl: string; note: string }[] }>(
    canManageProfiles ? "/api/admin/llm-profiles/probe" : null, "供应商预设读取失败");
  const [presetId, setPresetId] = useState("custom");
  const [probe, setProbe] = useState<{
    models: string[] | null; reason: string | null; latencyMs: number; busy: boolean; message: string;
  }>({ models: null, reason: null, latencyMs: 0, busy: false, message: "" });

  async function runProbe() {
    if (probe.busy) return;
    setProbe((current) => ({ ...current, busy: true, message: "" }));
    try {
      const response = await fetch("/api/admin/llm-profiles/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          // 已填模型名时顺带验证那个模型本身可用，不只是端点通。
          modelName: form.modelName || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "供应商连通测试失败"));
      setProbe({
        models: payload.models ?? null,
        reason: payload.modelsUnavailableReason ?? null,
        latencyMs: payload.latencyMs ?? 0,
        busy: false,
        message: payload.models
          ? `连通正常（${payload.latencyMs}ms），共 ${payload.models.length} 个可用模型。`
          : `连通正常（${payload.latencyMs}ms）。该供应商未提供模型列表，请手动填写模型名。`,
      });
    } catch (error) {
      setProbe({
        models: null, reason: null, latencyMs: 0, busy: false,
        message: error instanceof Error ? error.message : "供应商连通测试失败",
      });
    }
  }

  const [editingProfileId, setEditingProfileId] = useState("");
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [auditReason, setAuditReason] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const revisions = useApiData<{ revisions: RevisionView[] }>(selectedProfileId ? `/api/admin/llm-profiles/${encodeURIComponent(selectedProfileId)}/revisions` : null, "模型修订历史读取失败");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const allBindings = useMemo(() => [...(research.data?.bindings ?? []), ...(runtime.data?.bindings ?? [])], [research.data, runtime.data]);
  const selectionFor = (role: string) => selection[role] ?? allBindings.find((binding) => binding.role === role)?.profileId ?? "";

  async function refreshAll() { await Promise.all([profiles.refresh(), research.refresh(), runtime.refresh()]); }
  async function submit(action: ConfigurationAction | RollbackAction, reason: string) {
    setBusy(true); setMessage("");
    try {
      if (action.kind === "rollback") {
        const response = await fetch(`/api/admin/llm-profiles/${encodeURIComponent(action.profileId)}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revisionId: action.revisionId, expectedCurrentRevisionId: action.expectedCurrentRevisionId, reason }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, "模型回滚失败"));
        setMessage("模型 Profile 已从历史快照生成新的不可变修订；密钥和端点未回显。");
        setRollbackReason("");
        await Promise.all([refreshAll(), revisions.refresh()]);
        return;
      }
      if (action.kind === "test") {
        const endpoint = action.runtime ? "/api/admin/runtime-explanation-bindings/test" : "/api/admin/agent-role-bindings/test";
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: action.role, reason }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, "连通测试失败"));
        setMessage(`连通测试完成：${payload.modelName || "已配置模型"} · ${payload.latencyMs ?? "—"}ms。`);
        return;
      }
      const endpoint = action.kind === "profile" ? editingProfileId ? `/api/admin/llm-profiles/${encodeURIComponent(editingProfileId)}` : "/api/admin/llm-profiles" : action.runtime ? "/api/admin/runtime-explanation-bindings" : "/api/admin/agent-role-bindings";
      const method = action.kind === "profile" ? editingProfileId ? "PATCH" : "POST" : "PUT";
      const body = action.kind === "profile" ? { ...form, reason } : { role: action.role, profileId: action.profileId, enabled: action.enabled, reason };
      const response = await fetch(endpoint, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "模型配置保存失败"));
      setMessage(action.kind === "profile" ? "模型 Profile 已生成不可变修订；密钥和完整端点不会回显。" : "Agent 绑定已更新并记录审计原因。");
      if (action.kind === "profile") { setForm({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true }); setEditingProfileId(""); }
      await refreshAll();
    } catch (error) { setMessage(error instanceof Error ? error.message : "模型配置保存失败"); }
    finally { setBusy(false); }
  }
  const loading = profiles.loading || research.loading || runtime.loading;
  const error = profiles.error || research.error || runtime.error;
  if (loading && !profiles.data) return <LoadingState label="正在读取模型编排…" />;
  if (error && !profiles.data) return <ErrorState message={error} retry={() => void refreshAll()} />;
  return <>
    <PageHeading eyebrow="MODEL ORCHESTRATION" title="模型与 Agent" description="读取与修改权限分离；浏览器只显示模型标识、密钥存在状态和不可变修订。" />
    <div className="rc-live" aria-live="polite">{message}</div>
    {(canManageProfiles || canManageBindings) ? <section className="rc-panel"><header><div><small>CONFIGURATION AUDIT</small><h2>本轮配置原因</h2><p>填写一次即可连续保存 Profile、绑定角色和执行连通测试，不再逐项弹窗确认。</p></div></header><div className="rc-form"><InlineAuditReasonField id="model-configuration-reason" value={auditReason} onChange={setAuditReason} label="配置与测试原因" /></div></section> : null}
    <div className="rc-split-layout">
      {canManageProfiles && <section className="rc-panel"><header><div><small>{editingProfileId ? "编辑并生成修订" : "新增配置"}</small><h2>模型 Profile</h2></div>{editingProfileId ? <button className="rc-button" type="button" onClick={() => { setEditingProfileId(""); setForm({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true }); }}>取消编辑</button> : null}</header><div className="rc-form"><label>配置名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>供应商预设<select value={presetId} onChange={(event) => {
        const next = presets.data?.presets.find((item) => item.id === event.target.value);
        setPresetId(event.target.value);
        // 预设只填地址，不锁死：填完仍可改成任何 OpenAI 兼容端点。
        if (next) setForm((current) => ({
          ...current,
          baseUrl: next.baseUrl || current.baseUrl,
          providerName: current.providerName || next.label,
        }));
        setProbe({ models: null, reason: null, latencyMs: 0, busy: false, message: "" });
      }}>{(presets.data?.presets ?? []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      <small>{presets.data?.presets.find((item) => item.id === presetId)?.note ?? "预设只是填表模板，地址仍可自由修改。"}</small></label>
      <label>供应商名称<input value={form.providerName} onChange={(event) => setForm({ ...form, providerName: event.target.value })} /></label><label>模型名称{probe.models
        ? <select value={form.modelName} onChange={(event) => setForm({ ...form, modelName: event.target.value })}>
            <option value="">从 {probe.models.length} 个可用模型中选择</option>
            {probe.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        : <input value={form.modelName} onChange={(event) => setForm({ ...form, modelName: event.target.value })} placeholder="先测试连通以获取可选模型，或直接填写" />}</label><label>服务端点（{editingProfileId ? "留空保留现值；填写则轮换" : "保存后不回显"}）<input type="password" autoComplete="off" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label><label>API Key（{editingProfileId ? "留空保留现值；填写则轮换" : "保存后不回显"}）<input type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></label><label className="rc-check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用 Profile</label><div className="rc-action-row">
        <button className="rc-button" type="button" disabled={probe.busy || !form.baseUrl || !form.apiKey}
          onClick={() => void runProbe()}>{probe.busy ? "测试中…" : "测试连通并获取模型"}</button>
        <button className="rc-primary" type="button" disabled={busy || !hasValidAuditReason(auditReason)} onClick={() => void submit({ kind: "profile" }, auditReason.trim())}>{busy ? "正在保存…" : editingProfileId ? "生成新修订" : "保存 Profile"}</button>
      </div>
      {probe.message ? <p className="rc-callout" role="status">{probe.message}</p> : null}
      {/* 编辑现有 Profile 时地址与密钥留空表示沿用旧值，那时无法测试——
          必须重新填入才能验证，否则测的是一个不完整的配置。 */}
      {editingProfileId && (!form.baseUrl || !form.apiKey)
        ? <p className="rc-callout" role="status">编辑模式下地址与密钥留空表示沿用现值；要重新测试请完整填写两者。</p>
        : null}</div></section>}
      <section className="rc-panel"><header><div><small>{profiles.data?.profiles.length ?? 0} 个配置</small><h2>安全配置状态</h2></div></header>{!profiles.data?.profiles.length ? <EmptyState title="没有模型 Profile" description="Research Agent 将保持暂停或未配置状态。" /> : <div className="rc-card-list">{profiles.data.profiles.map((profile) => <article key={profile.id}><header><div><b>{profile.name}</b><small>{profile.providerName} · {profile.modelName}</small></div><StatusBadge value={profile.enabled ? "enabled" : "disabled"} /></header><p>密钥：{profile.hasSecret ? "已保存（不可回显）" : "未配置"} · 修订：{profile.currentRevisionId ? "已生成" : "未生成"} · {formatDateTime(profile.updatedAt)}</p><div className="rc-action-row"><button className="rc-button" type="button" onClick={() => setSelectedProfileId(profile.id)}>查看版本与回滚</button>{canManageProfiles ? <button className="rc-button" type="button" onClick={() => { setEditingProfileId(profile.id); setForm({ name: profile.name, providerName: profile.providerName, baseUrl: "", modelName: profile.modelName, apiKey: "", enabled: profile.enabled }); }}>编辑 / 轮换</button> : null}</div></article>)}</div>}</section>
    </div>
    {selectedProfileId ? <section className="rc-panel"><header><div><small>IMMUTABLE REVISIONS</small><h2>Profile 版本历史</h2></div><button className="rc-button" type="button" onClick={() => { setSelectedProfileId(""); setRollbackReason(""); }}>关闭</button></header>{canManageProfiles ? <div className="rc-form"><InlineAuditReasonField id="model-rollback-reason" value={rollbackReason} onChange={setRollbackReason} label="回滚原因" hint="回滚会从选中的历史快照创建新修订，不删除或覆盖任何历史。填写原因后可直接执行。" /></div> : null}{revisions.loading && !revisions.data ? <LoadingState /> : revisions.error && !revisions.data ? <ErrorState message={revisions.error} retry={revisions.refresh} /> : !revisions.data?.revisions.length ? <EmptyState title="没有修订记录" description="该 Profile 尚未产生版本。" /> : <div className="rc-card-list">{revisions.data.revisions.map((revision) => <article key={revision.id}><header><div><b>修订 {revision.revisionNumber} · {revision.modelName}</b><small>{revision.providerName} · {formatDateTime(revision.createdAt)}</small></div><StatusBadge value={revision.isCurrent ? "current" : revision.enabled ? "historical" : "disabled"} /></header><p>密钥：{revision.hasSecret ? "存在（不可回显）" : "缺失"} · 创建人 {revision.createdByUserId}</p>{canManageProfiles && !revision.isCurrent && <button className="rc-button" type="button" disabled={busy || !hasValidAuditReason(rollbackReason)} onClick={() => { const current = revisions.data?.revisions.find((item) => item.isCurrent); if (current) void submit({ kind: "rollback", profileId: selectedProfileId, revisionId: revision.id, expectedCurrentRevisionId: current.id }, rollbackReason.trim()); }}>回滚到此版本</button>}</article>)}</div>}</section> : null}
    <BindingPanel title="Research Agent 绑定" bindings={research.data?.bindings ?? []} profiles={profiles.data?.profiles ?? []} canManage={canManageBindings} selectionFor={selectionFor} setSelection={setSelection} runtime={false} busy={busy} reasonReady={hasValidAuditReason(auditReason)} onAction={(action) => void submit(action, auditReason.trim())} />
    <BindingPanel title="Runtime 解释 Agent 绑定" bindings={runtime.data?.bindings ?? []} profiles={profiles.data?.profiles ?? []} canManage={canManageBindings} selectionFor={selectionFor} setSelection={setSelection} runtime busy={busy} reasonReady={hasValidAuditReason(auditReason)} onAction={(action) => void submit(action, auditReason.trim())} />
    <section className="rc-panel"><header><div><small>PRODUCT PIPELINE</small><h2>七智能体确定性阶段目录</h2></div><StatusBadge value="simulation_only" /></header><p className="rc-muted">七阶段是有顺序、可退回且受硬风控约束的产品流程，不等同于七个可任意绑定的 LLM。上方 Profile 只负责允许使用模型的解释/研究角色。</p><div className="rc-card-list">{tradingHallAgentCatalog.map((agent) => <article key={agent.key}><header><div><b>{agent.sequence}. {agent.name}</b><small>{agent.key}</small></div></header><p>{agent.question}</p><small>固定输出：{agent.outputName}</small></article>)}</div></section>
  </>;
}

function BindingPanel({ title, bindings, profiles, canManage, selectionFor, setSelection, runtime, busy, reasonReady, onAction }: { title: string; bindings: MaintenanceAgentBinding[]; profiles: MaintenanceModelProfile[]; canManage: boolean; selectionFor: (role: string) => string; setSelection: React.Dispatch<React.SetStateAction<Record<string, string>>>; runtime: boolean; busy: boolean; reasonReady: boolean; onAction: (action: ConfigurationAction) => void }) {
  const roles = runtime ? ["market_summary", "adversarial_explanation", "risk_explanation"] : ["requirements", "market_regime", "proposal_a", "proposal_b", "adversarial_review", "risk_review", "report"];
  return <section className="rc-panel"><header><div><small>{runtime ? "RUNTIME" : "RESEARCH"}</small><h2>{title}</h2></div></header><div className="rc-binding-grid">{roles.map((role) => { const binding = bindings.find((item) => item.role === role); const profileId = selectionFor(role); return <article key={role}><div><b>{role}</b><small>{binding?.configured ? `${binding.modelName} · 修订 ${binding.revisionNumber}` : "未配置"}</small></div><StatusBadge value={binding?.configured ? "configured" : "unconfigured"} /><select aria-label={`${role} Profile`} disabled={!canManage || busy} value={profileId} onChange={(event) => setSelection((current) => ({ ...current, [role]: event.target.value }))}><option value="">选择 Profile</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelName}</option>)}</select>{canManage && <div className="rc-action-row"><button className="rc-button" disabled={!profileId || busy || !reasonReady} type="button" onClick={() => onAction({ kind: "binding", role, profileId, runtime, enabled: true })}>绑定</button><button className="rc-button" disabled={!binding?.configured || busy || !reasonReady} type="button" onClick={() => onAction({ kind: "test", role, runtime })}>测试</button>{binding?.enabled && <button className="rc-button" disabled={busy || !reasonReady} type="button" onClick={() => onAction({ kind: "binding", role, profileId, runtime, enabled: false })}>停用</button>}</div>}</article>; })}</div></section>;
}
