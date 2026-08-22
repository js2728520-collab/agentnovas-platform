"use client";

import { useCallback, useEffect, useState } from "react";

type Profile = {
  id: string;
  name: string;
  providerName: string;
  baseUrl: string;
  modelName: string;
  maskedApiKey: string;
  enabled: boolean;
};

type Binding = {
  role: string;
  profileId: string;
  modelName: string;
  configured: boolean;
  enabled: boolean;
};

const researchRoles = [
  "requirements",
  "market_regime",
  "proposal_a",
  "proposal_b",
  "adversarial_review",
  "risk_review",
  "report",
];

const runtimeRoles = [
  "market_summary",
  "adversarial_explanation",
  "risk_explanation",
];

const roleLabel: Record<string, string> = {
  requirements: "需求分析",
  market_regime: "市场状态",
  proposal_a: "提案 A",
  proposal_b: "提案 B",
  adversarial_review: "反方审查",
  risk_review: "风险审核",
  report: "报告生成",
  market_summary: "市场摘要解释",
  adversarial_explanation: "反方异议解释",
  risk_explanation: "风控结论解释",
};

function apiMessage(payload: unknown, fallback: string) {
  const error = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
  return error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message || fallback)
    : fallback;
}

export function AgentRoleAdmin() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [researchBindings, setResearchBindings] = useState<Binding[]>([]);
  const [runtimeBindings, setRuntimeBindings] = useState<Binding[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    name: "",
    providerName: "",
    baseUrl: "",
    modelName: "",
    apiKey: "",
    enabled: true,
  });

  const load = useCallback(async () => {
    const [profileResponse, researchResponse, runtimeResponse] = await Promise.all([
      fetch("/api/admin/llm-profiles", { cache: "no-store" }),
      fetch("/api/admin/agent-role-bindings", { cache: "no-store" }),
      fetch("/api/admin/runtime-explanation-bindings", { cache: "no-store" }),
    ]);
    const [profilePayload, researchPayload, runtimePayload] = await Promise.all([
      profileResponse.json().catch(() => null),
      researchResponse.json().catch(() => null),
      runtimeResponse.json().catch(() => null),
    ]);
    const failedPayload = !profileResponse.ok
      ? profilePayload
      : !researchResponse.ok
        ? researchPayload
        : !runtimeResponse.ok
          ? runtimePayload
          : null;
    if (failedPayload) {
      setNotice(apiMessage(failedPayload, "模型编排服务尚未配置"));
      return;
    }
    const profilesValue = profilePayload.profiles || [];
    const researchValue = researchPayload.bindings || [];
    const runtimeValue = runtimePayload.bindings || [];
    setProfiles(profilesValue);
    setResearchBindings(researchValue);
    setRuntimeBindings(runtimeValue);
    setSelection(Object.fromEntries(
      [...researchValue, ...runtimeValue].map((item: Binding) => [item.role, item.profileId]),
    ));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function edit(profile?: Profile) {
    setEditingId(profile?.id || "");
    setForm(profile ? {
      name: profile.name,
      providerName: profile.providerName,
      baseUrl: profile.baseUrl,
      modelName: profile.modelName,
      apiKey: "",
      enabled: profile.enabled,
    } : {
      name: "",
      providerName: "",
      baseUrl: "",
      modelName: "",
      apiKey: "",
      enabled: true,
    });
  }

  async function saveProfile() {
    const response = await fetch(editingId ? `/api/admin/llm-profiles/${editingId}` : "/api/admin/llm-profiles", {
      method: editingId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const payload = await response.json().catch(() => null);
    setNotice(response.ok ? "模型 Profile 已生成不可变修订并加密保存" : apiMessage(payload, "保存失败"));
    if (response.ok) {
      edit();
      await load();
    }
  }

  async function bind(role: string, runtime: boolean, enabled = true) {
    const response = await fetch(runtime
      ? "/api/admin/runtime-explanation-bindings"
      : "/api/admin/agent-role-bindings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, profileId: selection[role], enabled }),
    });
    const payload = await response.json().catch(() => null);
    setNotice(response.ok
      ? `${roleLabel[role]}已${enabled ? "绑定" : "停用"}`
      : apiMessage(payload, "绑定失败"));
    if (response.ok) await load();
  }

  async function test(role: string, runtime: boolean) {
    setNotice(`${roleLabel[role]}连通测试中…`);
    const response = await fetch(runtime
      ? "/api/admin/runtime-explanation-bindings/test"
      : "/api/admin/agent-role-bindings/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const payload = await response.json().catch(() => null);
    setNotice(response.ok
      ? `${roleLabel[role]}连接成功 · ${payload.modelName} · ${payload.latencyMs}ms`
      : apiMessage(payload, "连接失败"));
  }

  function bindingGrid(roles: string[], bindings: Binding[], runtime: boolean) {
    return <div className="agent-binding-grid">{roles.map(role => {
      const binding = bindings.find(item => item.role === role);
      return <article key={role}>
        <div>
          <b>{roleLabel[role]}</b>
          <small>{binding?.configured
            ? `${binding.modelName} · 已就绪`
            : runtime
              ? "可选；未配置不影响确定性运行"
              : "未配置；研发任务会暂停"}</small>
        </div>
        <select
          aria-label={`${roleLabel[role]}模型 Profile`}
          value={selection[role] || ""}
          onChange={event => setSelection(current => ({ ...current, [role]: event.target.value }))}
        >
          <option value="">选择 Profile</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>
            {profile.name} · {profile.modelName}
          </option>)}
        </select>
        <button type="button" disabled={!selection[role]} onClick={() => void bind(role, runtime)}>绑定</button>
        <button type="button" disabled={!binding?.configured} onClick={() => void test(role, runtime)}>测试</button>
        {runtime && binding?.enabled && <button type="button" onClick={() => void bind(role, true, false)}>停用</button>}
      </article>;
    })}</div>;
  }

  return <section className="agent-role-admin">
    <header>
      <div>
        <small>MODEL ORCHESTRATION</small>
        <h3>多 Agent 模型 Profile 与角色绑定</h3>
        <p>供应商地址和密钥仅管理员可见；客户只看到角色与模型名称。</p>
      </div>
      <button type="button" onClick={() => edit()}>新增 Profile</button>
    </header>
    {notice && <p className="admin-notice">{notice}</p>}
    <div className="agent-profile-grid">{profiles.map(profile => <button type="button" key={profile.id} onClick={() => edit(profile)}>
      <b>{profile.name}</b><span>{profile.modelName}</span>
      <small>{profile.providerName} · {profile.enabled ? "启用" : "停用"} · {profile.maskedApiKey}</small>
    </button>)}</div>
    <div className="agent-profile-form">
      <label>配置名称<input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
      <label>供应商（仅管理员可见）<input value={form.providerName} onChange={event => setForm(current => ({ ...current, providerName: event.target.value }))} /></label>
      <label>HTTPS 接口地址<input value={form.baseUrl} onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label>
      <label>模型名称<input value={form.modelName} onChange={event => setForm(current => ({ ...current, modelName: event.target.value }))} /></label>
      <label>API Key<input type="password" value={form.apiKey} onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))} placeholder={editingId ? "留空则保留原 Key" : "首次配置必填"} /></label>
      <label className="profile-enabled"><input type="checkbox" checked={form.enabled} onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))} />启用此 Profile</label>
      <button type="button" className="primary" onClick={() => void saveProfile()}>{editingId ? "更新 Profile" : "保存 Profile"}</button>
    </div>
    <section className="agent-binding-section">
      <header><div><small>RESEARCH PIPELINE</small><h4>研发 Agent 模型绑定</h4></div><p>七个关键角色必须全部配置；任务创建时固定具体 Profile 修订。</p></header>
      {bindingGrid(researchRoles, researchBindings, false)}
    </section>
    <section className="agent-binding-section runtime">
      <header><div><small>RUNTIME EXPLANATIONS</small><h4>运行时可选解释模型</h4></div><p>异步说明市场、反方和风控结论；模型超时不阻塞周期，也不能改变信号或订单。</p></header>
      {bindingGrid(runtimeRoles, runtimeBindings, true)}
    </section>
  </section>;
}
