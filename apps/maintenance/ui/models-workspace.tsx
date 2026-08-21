"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime, type MaintenanceAgentBinding, type MaintenanceModelProfile } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { tradingHallAgentCatalog } from "@/packages/contracts/src/trading-hall";

type Pending = { kind: "profile" }
  | { kind: "binding"; role: string; profileId: string; runtime: boolean; enabled: boolean }
  | { kind: "test"; role: string; runtime: boolean }
  | { kind: "rollback"; profileId: string; revisionId: string; expectedCurrentRevisionId: string };
type RevisionView = { id: string; revisionNumber: number; name: string; providerName: string; modelName: string; hasSecret: boolean; enabled: boolean; isCurrent: boolean; createdByUserId: string; createdAt: string };

export function ModelsWorkspace({ canManageProfiles, canManageBindings }: { canManageProfiles: boolean; canManageBindings: boolean }) {
  const profiles = useApiData<{ profiles: MaintenanceModelProfile[] }>("/api/admin/llm-profiles", "模型 Profile 读取失败");
  const research = useApiData<{ bindings: MaintenanceAgentBinding[] }>("/api/admin/agent-role-bindings", "Research Agent 绑定读取失败");
  const runtime = useApiData<{ bindings: MaintenanceAgentBinding[] }>("/api/admin/runtime-explanation-bindings", "Runtime Agent 绑定读取失败");
  const [form, setForm] = useState({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true });
  const [editingProfileId, setEditingProfileId] = useState("");
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const revisions = useApiData<{ revisions: RevisionView[] }>(selectedProfileId ? `/api/admin/llm-profiles/${encodeURIComponent(selectedProfileId)}/revisions` : null, "模型修订历史读取失败");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const allBindings = useMemo(() => [...(research.data?.bindings ?? []), ...(runtime.data?.bindings ?? [])], [research.data, runtime.data]);
  const selectionFor = (role: string) => selection[role] ?? allBindings.find((binding) => binding.role === role)?.profileId ?? "";

  async function refreshAll() { await Promise.all([profiles.refresh(), research.refresh(), runtime.refresh()]); }
  async function submit(reason: string) {
    if (!pending) return;
    setBusy(true); setMessage("");
    try {
      if (pending.kind === "rollback") {
        const response = await fetch(`/api/admin/llm-profiles/${encodeURIComponent(pending.profileId)}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revisionId: pending.revisionId, expectedCurrentRevisionId: pending.expectedCurrentRevisionId, reason }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, "模型回滚失败"));
        setMessage("模型 Profile 已从历史快照生成新的不可变修订；密钥和端点未回显。");
        setPending(null);
        await Promise.all([refreshAll(), revisions.refresh()]);
        return;
      }
      if (pending.kind === "test") {
        const endpoint = pending.runtime ? "/api/admin/runtime-explanation-bindings/test" : "/api/admin/agent-role-bindings/test";
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: pending.role, reason }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, "连通测试失败"));
        setMessage(`连通测试完成：${payload.modelName || "已配置模型"} · ${payload.latencyMs ?? "—"}ms。`);
        setPending(null);
        return;
      }
      const endpoint = pending.kind === "profile" ? editingProfileId ? `/api/admin/llm-profiles/${encodeURIComponent(editingProfileId)}` : "/api/admin/llm-profiles" : pending.runtime ? "/api/admin/runtime-explanation-bindings" : "/api/admin/agent-role-bindings";
      const method = pending.kind === "profile" ? editingProfileId ? "PATCH" : "POST" : "PUT";
      const body = pending.kind === "profile" ? { ...form, reason } : { role: pending.role, profileId: pending.profileId, enabled: pending.enabled, reason };
      const response = await fetch(endpoint, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "模型配置保存失败"));
      setMessage(pending.kind === "profile" ? "模型 Profile 已生成不可变修订；密钥和完整端点不会回显。" : "Agent 绑定已更新并记录审计原因。");
      if (pending.kind === "profile") { setForm({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true }); setEditingProfileId(""); }
      setPending(null); await refreshAll();
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
    <div className="rc-split-layout">
      {canManageProfiles && <section className="rc-panel"><header><div><small>{editingProfileId ? "编辑并生成修订" : "新增配置"}</small><h2>模型 Profile</h2></div>{editingProfileId ? <button className="rc-button" type="button" onClick={() => { setEditingProfileId(""); setForm({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true }); }}>取消编辑</button> : null}</header><div className="rc-form"><label>配置名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>供应商<input value={form.providerName} onChange={(event) => setForm({ ...form, providerName: event.target.value })} /></label><label>模型名称<input value={form.modelName} onChange={(event) => setForm({ ...form, modelName: event.target.value })} /></label><label>服务端点（{editingProfileId ? "留空保留现值；填写则轮换" : "保存后不回显"}）<input type="password" autoComplete="off" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label><label>API Key（{editingProfileId ? "留空保留现值；填写则轮换" : "保存后不回显"}）<input type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></label><label className="rc-check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用 Profile</label><button className="rc-primary" type="button" onClick={() => setPending({ kind: "profile" })}>{editingProfileId ? "检查并生成新修订" : "检查并保存"}</button></div></section>}
      <section className="rc-panel"><header><div><small>{profiles.data?.profiles.length ?? 0} 个配置</small><h2>安全配置状态</h2></div></header>{!profiles.data?.profiles.length ? <EmptyState title="没有模型 Profile" description="Research Agent 将保持暂停或未配置状态。" /> : <div className="rc-card-list">{profiles.data.profiles.map((profile) => <article key={profile.id}><header><div><b>{profile.name}</b><small>{profile.providerName} · {profile.modelName}</small></div><StatusBadge value={profile.enabled ? "enabled" : "disabled"} /></header><p>密钥：{profile.hasSecret ? "已保存（不可回显）" : "未配置"} · 修订：{profile.currentRevisionId ? "已生成" : "未生成"} · {formatDateTime(profile.updatedAt)}</p><div className="rc-action-row"><button className="rc-button" type="button" onClick={() => setSelectedProfileId(profile.id)}>查看版本与回滚</button>{canManageProfiles ? <button className="rc-button" type="button" onClick={() => { setEditingProfileId(profile.id); setForm({ name: profile.name, providerName: profile.providerName, baseUrl: "", modelName: profile.modelName, apiKey: "", enabled: profile.enabled }); }}>编辑 / 轮换</button> : null}</div></article>)}</div>}</section>
    </div>
    {selectedProfileId ? <section className="rc-panel"><header><div><small>IMMUTABLE REVISIONS</small><h2>Profile 版本历史</h2></div><button className="rc-button" type="button" onClick={() => setSelectedProfileId("")}>关闭</button></header>{revisions.loading && !revisions.data ? <LoadingState /> : revisions.error && !revisions.data ? <ErrorState message={revisions.error} retry={revisions.refresh} /> : !revisions.data?.revisions.length ? <EmptyState title="没有修订记录" description="该 Profile 尚未产生版本。" /> : <div className="rc-card-list">{revisions.data.revisions.map((revision) => <article key={revision.id}><header><div><b>修订 {revision.revisionNumber} · {revision.modelName}</b><small>{revision.providerName} · {formatDateTime(revision.createdAt)}</small></div><StatusBadge value={revision.isCurrent ? "current" : revision.enabled ? "historical" : "disabled"} /></header><p>密钥：{revision.hasSecret ? "存在（不可回显）" : "缺失"} · 创建人 {revision.createdByUserId}</p>{canManageProfiles && !revision.isCurrent && <button className="rc-button" type="button" onClick={() => { const current = revisions.data?.revisions.find((item) => item.isCurrent); if (current) setPending({ kind: "rollback", profileId: selectedProfileId, revisionId: revision.id, expectedCurrentRevisionId: current.id }); }}>回滚到此版本</button>}</article>)}</div>}</section> : null}
    <BindingPanel title="Research Agent 绑定" bindings={research.data?.bindings ?? []} profiles={profiles.data?.profiles ?? []} canManage={canManageBindings} selectionFor={selectionFor} setSelection={setSelection} runtime={false} onPending={setPending} />
    <BindingPanel title="Runtime 解释 Agent 绑定" bindings={runtime.data?.bindings ?? []} profiles={profiles.data?.profiles ?? []} canManage={canManageBindings} selectionFor={selectionFor} setSelection={setSelection} runtime onPending={setPending} />
    <section className="rc-panel"><header><div><small>PRODUCT PIPELINE</small><h2>七智能体确定性阶段目录</h2></div><StatusBadge value="simulation_only" /></header><p className="rc-muted">七阶段是有顺序、可退回且受硬风控约束的产品流程，不等同于七个可任意绑定的 LLM。上方 Profile 只负责允许使用模型的解释/研究角色。</p><div className="rc-card-list">{tradingHallAgentCatalog.map((agent) => <article key={agent.key}><header><div><b>{agent.sequence}. {agent.name}</b><small>{agent.key}</small></div></header><p>{agent.question}</p><small>固定输出：{agent.outputName}</small></article>)}</div></section>
    <ConfirmActionDialog open={Boolean(pending)} title={pending?.kind === "profile" ? "保存模型 Profile" : pending?.kind === "test" ? "执行模型连通测试" : pending?.kind === "rollback" ? "回滚模型 Profile" : "更新 Agent 绑定"} description={pending?.kind === "test" ? "测试会访问当前绑定的外部模型端点，并记录操作原因；不会回显密钥或完整端点。" : pending?.kind === "rollback" ? "系统会从目标快照创建新的不可变修订；不会删除历史，也不会回显密钥或端点。" : "配置变更会生成审计记录。密钥和完整端点保存后不会回显。"} confirmLabel={pending?.kind === "test" ? "确认并测试" : pending?.kind === "rollback" ? "确认回滚" : "确认并保存"} busy={busy} onCancel={() => setPending(null)} onConfirm={(reason) => void submit(reason)} />
  </>;
}

function BindingPanel({ title, bindings, profiles, canManage, selectionFor, setSelection, runtime, onPending }: { title: string; bindings: MaintenanceAgentBinding[]; profiles: MaintenanceModelProfile[]; canManage: boolean; selectionFor: (role: string) => string; setSelection: React.Dispatch<React.SetStateAction<Record<string, string>>>; runtime: boolean; onPending: (pending: Pending) => void }) {
  const roles = runtime ? ["market_summary", "adversarial_explanation", "risk_explanation"] : ["requirements", "market_regime", "proposal_a", "proposal_b", "adversarial_review", "risk_review", "report"];
  return <section className="rc-panel"><header><div><small>{runtime ? "RUNTIME" : "RESEARCH"}</small><h2>{title}</h2></div></header><div className="rc-binding-grid">{roles.map((role) => { const binding = bindings.find((item) => item.role === role); const profileId = selectionFor(role); return <article key={role}><div><b>{role}</b><small>{binding?.configured ? `${binding.modelName} · 修订 ${binding.revisionNumber}` : "未配置"}</small></div><StatusBadge value={binding?.configured ? "configured" : "unconfigured"} /><select aria-label={`${role} Profile`} disabled={!canManage} value={profileId} onChange={(event) => setSelection((current) => ({ ...current, [role]: event.target.value }))}><option value="">选择 Profile</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelName}</option>)}</select>{canManage && <div className="rc-action-row"><button className="rc-button" disabled={!profileId} type="button" onClick={() => onPending({ kind: "binding", role, profileId, runtime, enabled: true })}>绑定</button><button className="rc-button" disabled={!binding?.configured} type="button" onClick={() => onPending({ kind: "test", role, runtime })}>测试</button>{binding?.enabled && <button className="rc-button" type="button" onClick={() => onPending({ kind: "binding", role, profileId, runtime, enabled: false })}>停用</button>}</div>}</article>; })}</div></section>;
}
