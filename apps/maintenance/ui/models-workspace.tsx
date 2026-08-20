"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage, formatDateTime, type MaintenanceAgentBinding, type MaintenanceModelProfile } from "@/packages/contracts/src/riverton-ui";
import { ConfirmActionDialog } from "@/packages/ui/src/confirm-action-dialog";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

type Pending = { kind: "profile" }
  | { kind: "binding"; role: string; profileId: string; runtime: boolean; enabled: boolean }
  | { kind: "test"; role: string; runtime: boolean };

export function ModelsWorkspace({ canManageProfiles, canManageBindings }: { canManageProfiles: boolean; canManageBindings: boolean }) {
  const profiles = useApiData<{ profiles: MaintenanceModelProfile[] }>("/api/admin/llm-profiles", "模型 Profile 读取失败");
  const research = useApiData<{ bindings: MaintenanceAgentBinding[] }>("/api/admin/agent-role-bindings", "Research Agent 绑定读取失败");
  const runtime = useApiData<{ bindings: MaintenanceAgentBinding[] }>("/api/admin/runtime-explanation-bindings", "Runtime Agent 绑定读取失败");
  const [form, setForm] = useState({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true });
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const allBindings = useMemo(() => [...(research.data?.bindings ?? []), ...(runtime.data?.bindings ?? [])], [research.data, runtime.data]);
  const selectionFor = (role: string) => selection[role] ?? allBindings.find((binding) => binding.role === role)?.profileId ?? "";

  async function refreshAll() { await Promise.all([profiles.refresh(), research.refresh(), runtime.refresh()]); }
  async function submit(reason: string) {
    if (!pending) return;
    setBusy(true); setMessage("");
    try {
      if (pending.kind === "test") {
        const endpoint = pending.runtime ? "/api/admin/runtime-explanation-bindings/test" : "/api/admin/agent-role-bindings/test";
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: pending.role, reason }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(payload, "连通测试失败"));
        setMessage(`连通测试完成：${payload.modelName || "已配置模型"} · ${payload.latencyMs ?? "—"}ms。`);
        setPending(null);
        return;
      }
      const endpoint = pending.kind === "profile" ? "/api/admin/llm-profiles" : pending.runtime ? "/api/admin/runtime-explanation-bindings" : "/api/admin/agent-role-bindings";
      const method = pending.kind === "profile" ? "POST" : "PUT";
      const body = pending.kind === "profile" ? { ...form, reason } : { role: pending.role, profileId: pending.profileId, enabled: pending.enabled, reason };
      const response = await fetch(endpoint, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "模型配置保存失败"));
      setMessage(pending.kind === "profile" ? "模型 Profile 已生成不可变修订；密钥和完整端点不会回显。" : "Agent 绑定已更新并记录审计原因。");
      if (pending.kind === "profile") setForm({ name: "", providerName: "", baseUrl: "", modelName: "", apiKey: "", enabled: true });
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
      {canManageProfiles && <section className="rc-panel"><header><div><small>新增配置</small><h2>模型 Profile</h2></div></header><div className="rc-form"><label>配置名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>供应商<input value={form.providerName} onChange={(event) => setForm({ ...form, providerName: event.target.value })} /></label><label>模型名称<input value={form.modelName} onChange={(event) => setForm({ ...form, modelName: event.target.value })} /></label><label>服务端点（保存后不回显）<input type="password" autoComplete="off" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label><label>API Key（保存后不回显）<input type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></label><label className="rc-check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用 Profile</label><button className="rc-primary" type="button" onClick={() => setPending({ kind: "profile" })}>检查并保存</button></div></section>}
      <section className="rc-panel"><header><div><small>{profiles.data?.profiles.length ?? 0} 个配置</small><h2>安全配置状态</h2></div></header>{!profiles.data?.profiles.length ? <EmptyState title="没有模型 Profile" description="Research Agent 将保持暂停或未配置状态。" /> : <div className="rc-card-list">{profiles.data.profiles.map((profile) => <article key={profile.id}><header><div><b>{profile.name}</b><small>{profile.providerName} · {profile.modelName}</small></div><StatusBadge value={profile.enabled ? "enabled" : "disabled"} /></header><p>密钥：{profile.hasSecret ? "已保存（不可回显）" : "未配置"} · 修订：{profile.currentRevisionId ? "已生成" : "未生成"} · {formatDateTime(profile.updatedAt)}</p></article>)}</div>}</section>
    </div>
    <BindingPanel title="Research Agent 绑定" bindings={research.data?.bindings ?? []} profiles={profiles.data?.profiles ?? []} canManage={canManageBindings} selectionFor={selectionFor} setSelection={setSelection} runtime={false} onPending={setPending} />
    <BindingPanel title="Runtime 解释 Agent 绑定" bindings={runtime.data?.bindings ?? []} profiles={profiles.data?.profiles ?? []} canManage={canManageBindings} selectionFor={selectionFor} setSelection={setSelection} runtime onPending={setPending} />
    <ConfirmActionDialog open={Boolean(pending)} title={pending?.kind === "profile" ? "保存模型 Profile" : pending?.kind === "test" ? "执行模型连通测试" : "更新 Agent 绑定"} description={pending?.kind === "test" ? "测试会访问当前绑定的外部模型端点，并记录操作原因；不会回显密钥或完整端点。" : "配置变更会生成审计记录。密钥和完整端点保存后不会回显。"} confirmLabel={pending?.kind === "test" ? "确认并测试" : "确认并保存"} busy={busy} onCancel={() => setPending(null)} onConfirm={(reason) => void submit(reason)} />
  </>;
}

function BindingPanel({ title, bindings, profiles, canManage, selectionFor, setSelection, runtime, onPending }: { title: string; bindings: MaintenanceAgentBinding[]; profiles: MaintenanceModelProfile[]; canManage: boolean; selectionFor: (role: string) => string; setSelection: React.Dispatch<React.SetStateAction<Record<string, string>>>; runtime: boolean; onPending: (pending: Pending) => void }) {
  const roles = runtime ? ["market_summary", "adversarial_explanation", "risk_explanation"] : ["requirements", "market_regime", "proposal_a", "proposal_b", "adversarial_review", "risk_review", "report"];
  return <section className="rc-panel"><header><div><small>{runtime ? "RUNTIME" : "RESEARCH"}</small><h2>{title}</h2></div></header><div className="rc-binding-grid">{roles.map((role) => { const binding = bindings.find((item) => item.role === role); const profileId = selectionFor(role); return <article key={role}><div><b>{role}</b><small>{binding?.configured ? `${binding.modelName} · 修订 ${binding.revisionNumber}` : "未配置"}</small></div><StatusBadge value={binding?.configured ? "configured" : "unconfigured"} /><select aria-label={`${role} Profile`} disabled={!canManage} value={profileId} onChange={(event) => setSelection((current) => ({ ...current, [role]: event.target.value }))}><option value="">选择 Profile</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelName}</option>)}</select>{canManage && <div className="rc-action-row"><button className="rc-button" disabled={!profileId} type="button" onClick={() => onPending({ kind: "binding", role, profileId, runtime, enabled: true })}>绑定</button><button className="rc-button" disabled={!binding?.configured} type="button" onClick={() => onPending({ kind: "test", role, runtime })}>测试</button>{binding?.enabled && <button className="rc-button" type="button" onClick={() => onPending({ kind: "binding", role, profileId, runtime, enabled: false })}>停用</button>}</div>}</article>; })}</div></section>;
}
