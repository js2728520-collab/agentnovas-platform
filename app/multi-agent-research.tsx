"use client";

import { useEffect, useMemo, useState } from "react";

type Mode = "quick" | "standard" | "deep";
type EventRow = { id: string; sequence: number; role: string; type: string; title: string; content: Record<string, unknown>; createdAt: string };
type Candidate = { id: string; strategyFamily: string; sourceRole: string; dsl: Record<string, unknown>; status: string; rank: number | null; score: number | null; rejectionReasons: string[]; validationLabel: string; savedStrategyId: string | null };
type Evaluation = { candidateId: string; kind: string; metrics: { netReturnPct?: number; maxDrawdownPct?: number; profitFactor?: number; sampleSize?: number }; passed: boolean; finalHoldout: boolean };
type RunPayload = { run: { id: string; status: string; stage: string; progress: number; finalConclusion?: string | null; lastErrorMessage?: string | null }; events: EventRow[]; candidates: Candidate[]; evaluations: Evaluation[] };

const modes: Array<{ id: Mode; name: string; detail: string }> = [
  { id: "quick", name: "快速探索", detail: "3 个候选 · 12 次回测 · 仅模拟" },
  { id: "standard", name: "标准验证", detail: "6 个候选 · 60 次回测 · 60/20/20 留出" },
  { id: "deep", name: "深度研究", detail: "10 个候选 · 200 次回测 · 敏感性与 5 次走查" },
];

const roleNames: Record<string, string> = {
  requirements: "需求分析", market_regime: "市场状态", proposal_a: "提案 A", proposal_b: "提案 B",
  adversarial_review: "反方审查", risk_review: "风险审核", report: "报告生成",
  data_adapter: "数据适配器", dsl_validator: "DSL 校验器", optimizer: "参数优化器", scoring_engine: "评分引擎",
  proposal_team: "提案团队", orchestrator: "编排器",
};

function errorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message || fallback);
  return fallback;
}

export function MultiAgentResearch({
  ensureConversation,
  brief,
}: {
  ensureConversation: () => Promise<string>;
  brief: Record<string, unknown>;
}) {
  const [mode, setMode] = useState<Mode>("standard");
  const [accounts, setAccounts] = useState<Array<{ id: string; label: string; exchange: string; canRead: boolean; withdrawalAuthorized?: boolean; status: string }>>([]);
  const [accountId, setAccountId] = useState("");
  const [roles, setRoles] = useState<Array<{ role: string; modelName: string; configured: boolean; enabled: boolean }>>([]);
  const [ready, setReady] = useState(false);
  const [runId, setRunId] = useState("");
  const [payload, setPayload] = useState<RunPayload | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/exchange-accounts", { cache: "no-store" }).then(response => response.json().then(data => ({ ok: response.ok, data }))),
      fetch("/api/strategy-research/roles", { cache: "no-store" }).then(response => response.json().then(data => ({ ok: response.ok, data }))),
    ]).then(([accountResponse, roleResponse]) => {
      if (!active) return;
      if (accountResponse.ok) {
        const available = (accountResponse.data.accounts || []).filter((item: { exchange?: string; status?: string; canRead?: boolean; withdrawalAuthorized?: boolean }) =>
          ["OKX", "BINANCE", "BYBIT"].includes(String(item.exchange).toUpperCase())
          && item.status === "active"
          && item.canRead === true
          && item.withdrawalAuthorized !== true);
        setAccounts(available);
        setAccountId(available[0]?.id || "");
      }
      if (roleResponse.ok) {
        setRoles(roleResponse.data.roles || []);
        setReady(Boolean(roleResponse.data.ready));
      } else {
        setMessage(errorMessage(roleResponse.data, "多 Agent 服务尚未配置"));
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    const load = async () => {
      const response = await fetch(`/api/strategy-research/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!active) return;
      if (!response.ok) {
        setMessage(errorMessage(data, "读取研发任务失败"));
        return;
      }
      setPayload(data as RunPayload);
      const status = String((data as RunPayload).run.status);
      if (["completed", "failed", "cancelled"].includes(status)) setBusy(false);
    };
    void load();
    const source = new EventSource(`/api/strategy-research/runs/${encodeURIComponent(runId)}/events?afterSequence=0`);
    source.addEventListener("update", () => void load());
    source.addEventListener("done", () => { void load(); source.close(); });
    const timer = setInterval(() => void load(), 10_000);
    return () => { active = false; source.close(); clearInterval(timer); };
  }, [runId]);

  const evaluationByCandidate = useMemo(() => {
    const map = new Map<string, Evaluation>();
    for (const evaluation of payload?.evaluations || []) {
      if (evaluation.finalHoldout || (!map.has(evaluation.candidateId) && evaluation.kind === "validation_variant")) map.set(evaluation.candidateId, evaluation);
    }
    return map;
  }, [payload]);

  async function start() {
    if (!accountId) { setMessage("请先连接一个具有只读权限的 OKX、Binance 或 Bybit 账户"); return; }
    setBusy(true); setMessage(""); setPayload(null);
    try {
      const conversationId = await ensureConversation();
      const response = await fetch("/api/strategy-research/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ conversationId, exchangeAccountId: accountId, mode, brief }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.runId) throw new Error(errorMessage(data, "创建研发任务失败"));
      setRunId(String(data.runId));
      if (data.status === "paused_missing_role") setMessage("任务已创建，正在等待管理员补齐 Agent 模型绑定。配置完成后可恢复执行。");
    } catch (error) {
      setBusy(false);
      setMessage(error instanceof Error ? error.message : "创建研发任务失败");
    }
  }

  async function cancel() {
    if (!runId) return;
    const response = await fetch(`/api/strategy-research/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    const data = await response.json().catch(() => null);
    setMessage(response.ok ? "任务已取消；运行中的阶段结果不会再推进或保存。" : errorMessage(data, "取消失败"));
  }

  async function save(candidate: Candidate) {
    const response = await fetch(`/api/strategy-research/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidate.id)}/save`, { method: "POST" });
    const data = await response.json().catch(() => null);
    if (!response.ok) { setMessage(errorMessage(data, "保存失败")); return; }
    setMessage(data.simulationOnly ? "已保存到我的策略；该候选仅可用于模拟盘。" : "已保存到我的策略；已保留标准验证标签。");
  }

  return <section className="multi-agent-research">
    <header><div><small>MULTI-AGENT RESEARCH</small><h3>多 Agent 策略研发与验证</h3><p>模型负责提出与审查，参数搜索、真实历史回测、评分和准入由确定性引擎完成。</p></div><span className={ready ? "ready" : "waiting"}>{ready ? "7 个角色已配置" : "等待角色配置"}</span></header>
    <div className="research-role-strip">{roles.map(role => <span key={role.role}><b>{roleNames[role.role] || role.role}</b><small>{role.modelName}</small></span>)}</div>
    <div className="research-launch-grid">
      <div className="research-mode-grid">{modes.map(item => <button type="button" className={mode === item.id ? "selected" : ""} key={item.id} onClick={() => setMode(item.id)}><b>{item.name}</b><small>{item.detail}</small></button>)}</div>
      <label>数据账户<select value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">请选择只读交易所账户</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label} · {account.exchange}</option>)}</select></label>
      <div className="research-launch-actions"><button className="primary" disabled={busy || !ready} onClick={() => void start()}>{busy ? "后台研发中…" : "启动多 Agent 研发"}</button>{busy && <button onClick={() => void cancel()}>取消任务</button>}</div>
    </div>
    {message && <p className="research-message">{message}</p>}
    {payload && <>
      <div className="research-progress"><span><i style={{ width: `${payload.run.progress}%` }} /></span><b>{payload.run.progress}%</b><em>{payload.run.stage} · {payload.run.status}</em></div>
      <div className="research-timeline">{payload.events.map(event => <article key={event.id}><i>{event.sequence}</i><div><small>{roleNames[event.role] || event.role}</small><b>{event.title}</b><p>{String(event.content.conclusion || event.content.summary || "阶段结果已结构化保存")}</p></div></article>)}</div>
      {payload.candidates.length > 0 && <div className="research-candidates">{payload.candidates.filter(candidate => candidate.rank != null).slice(0, 3).map(candidate => {
        const evaluation = evaluationByCandidate.get(candidate.id);
        return <article key={candidate.id} className={candidate.validationLabel === "STANDARD_VERIFIED" ? "verified" : "failed"}>
          <header><b>#{candidate.rank} {candidate.strategyFamily}</b><span>{candidate.validationLabel}</span></header>
          <div><span>评分<b>{candidate.score?.toFixed(2) ?? "—"}</b></span><span>样本外收益<b>{evaluation?.metrics.netReturnPct == null ? "—" : `${evaluation.metrics.netReturnPct > 0 ? "+" : ""}${evaluation.metrics.netReturnPct.toFixed(2)}%`}</b></span><span>最大回撤<b>{evaluation?.metrics.maxDrawdownPct == null ? "—" : `${evaluation.metrics.maxDrawdownPct.toFixed(2)}%`}</b></span><span>交易数<b>{evaluation?.metrics.sampleSize ?? "—"}</b></span></div>
          {candidate.rejectionReasons.length > 0 && <ul>{candidate.rejectionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <button disabled={Boolean(candidate.savedStrategyId)} onClick={() => void save(candidate)}>{candidate.savedStrategyId ? "已保存到我的策略" : "保存到我的策略"}</button>
        </article>;
      })}</div>}
      {payload.candidates.some(candidate => candidate.rank == null) && <details className="research-other-candidates">
        <summary>查看其他研究候选（{payload.candidates.filter(candidate => candidate.rank == null).length}）</summary>
        <div>{payload.candidates.filter(candidate => candidate.rank == null).map(candidate => <article key={candidate.id}>
          <span><b>{candidate.strategyFamily}</b><small>{candidate.validationLabel} · {candidate.score?.toFixed(2) ?? "未评分"}</small></span>
          <button disabled={Boolean(candidate.savedStrategyId)} onClick={() => void save(candidate)}>{candidate.savedStrategyId ? "已保存" : "保存为研究草稿"}</button>
        </article>)}</div>
      </details>}
      {payload.run.finalConclusion && <div className={`research-conclusion ${payload.run.finalConclusion === "QUALIFIED" ? "pass" : "fail"}`}><b>{payload.run.finalConclusion === "QUALIFIED" ? "存在通过标准验证的候选" : "本轮没有候选通过标准验证"}</b><p>历史回测是研究证据，不代表未来收益。未通过候选不会被包装为已验证。</p></div>}
    </>}
  </section>;
}
