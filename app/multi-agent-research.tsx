"use client";

import { useEffect, useMemo, useState } from "react";

type Mode = "quick" | "standard" | "deep";
type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";
type Direction = "long_only" | "short_only" | "both";
type ResearchInstrument = { exchange: string; symbol: string; exchangeSymbol: string; status: "live"; quoteAsset: "USDT"; tickSize: number; lotSize: number; fundingIntervalHours: number };
type EventRow = { id: string; sequence: number; role: string; type: string; title: string; content: Record<string, unknown>; createdAt: string };
type Candidate = { id: string; strategyFamily: string; sourceRole: string; dsl: Record<string, unknown>; status: string; rank: number | null; score: number | null; rejectionReasons: string[]; validationLabel: string; savedStrategyId: string | null; savedStrategyVersionId: string | null };
type Evaluation = { candidateId: string; kind: string; metrics: { netReturnPct?: number; maxDrawdownPct?: number; profitFactor?: number; sampleSize?: number }; passed: boolean; finalHoldout: boolean };
type MissingField = { key: string; question: string; options: Array<string | number | boolean>; defaultValue: string | number | boolean };
type RunPayload = { run: { id: string; status: string; stage: string; progress: number; result?: { requirements?: { missingFields?: MissingField[] } }; finalConclusion?: string | null; lastErrorMessage?: string | null }; events: EventRow[]; candidates: Candidate[]; evaluations: Evaluation[] };
type ResearchRunSummary = {
  id: string;
  exchangeAccountId: string;
  mode: Mode;
  stage: string;
  status: string;
  progress: number;
  brief: Record<string, unknown>;
};
type RuntimeEvent = {
  sequence: number;
  role: string;
  type: string;
  conclusion: string;
  evidence: Record<string, unknown>;
  durationMs: number;
  llmUsed: boolean;
  modelName: string | null;
  explanationStatus: string;
  explanation: { summary: string; evidenceRefs: string[]; cautions: string[] } | null;
  explanationModelName: string | null;
  explanationDurationMs: number | null;
  explanationErrorCode: string | null;
};
type RuntimeCycle = { id: string; sequence: number; status: string; candleCloseTime: string; decision: { action?: string; reason?: string }; traceId: string; events: RuntimeEvent[] };
type ActiveDeployment = { id: string; mode: "shadow" | "paper"; status: string; strategyVersionId: string };

const modes: Array<{ id: Mode; name: string; detail: string }> = [
  { id: "quick", name: "快速探索", detail: "3 个候选 · 12 次回测 · 仅模拟" },
  { id: "standard", name: "标准验证", detail: "6 个候选 · 60 次回测 · 60/20/20 留出" },
  { id: "deep", name: "深度研究", detail: "10 个候选 · 200 次回测 · 敏感性与 5 次走查" },
];
const timeframes: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];
const directions: Array<{ id: Direction; label: string }> = [
  { id: "long_only", label: "仅做多" },
  { id: "short_only", label: "仅做空" },
  { id: "both", label: "双向" },
];
const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);

const roleNames: Record<string, string> = {
  requirements: "需求分析", market_regime: "市场状态", proposal_a: "提案 A", proposal_b: "提案 B",
  adversarial_review: "反方审查 Agent", risk_review: "风险审核", report: "报告生成",
  data_adapter: "数据适配器", dsl_validator: "DSL 校验器", optimizer: "参数优化器", scoring_engine: "评分引擎",
  proposal_team: "提案团队", orchestrator: "编排器",
  market_data: "市场数据 Agent", technical_analysis: "技术分析 Agent", strategy_decision: "策略决策 Agent",
  risk: "风控 Agent", execution: "执行 Agent", audit: "审计 Agent",
};

function errorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message || fallback);
  return fallback;
}

export function MultiAgentResearch({ brief }: { brief: Record<string, unknown> }) {
  const [mode, setMode] = useState<Mode>("standard");
  const [accounts, setAccounts] = useState<Array<{ id: string; label: string; exchange: string; canRead: boolean; withdrawalAuthorized?: boolean; status: string }>>([]);
  const [accountId, setAccountId] = useState("");
  const [instruments, setInstruments] = useState<ResearchInstrument[]>([]);
  const [instrumentId, setInstrumentId] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe | "">("");
  const [direction, setDirection] = useState<Direction | "">("");
  const [targetConfirmed, setTargetConfirmed] = useState(false);
  const [instrumentBusy, setInstrumentBusy] = useState(false);
  const [instrumentError, setInstrumentError] = useState("");
  const [instrumentRetry, setInstrumentRetry] = useState(0);
  const [roles, setRoles] = useState<Array<{ role: string; modelName: string; configured: boolean; enabled: boolean }>>([]);
  const [ready, setReady] = useState(false);
  const [restoringRun, setRestoringRun] = useState(true);
  const [runId, setRunId] = useState("");
  const [payload, setPayload] = useState<RunPayload | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [deployBusy, setDeployBusy] = useState("");
  const [activeDeployment, setActiveDeployment] = useState<ActiveDeployment | null>(null);
  const [runtimeCycles, setRuntimeCycles] = useState<RuntimeCycle[]>([]);
  const [inputAnswers, setInputAnswers] = useState<Record<string, string | number | boolean>>({});

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
    let active = true;
    fetch("/api/strategy-research/runs?scope=latest&limit=1", { cache: "no-store" })
      .then(async response => {
        const data = await response.json().catch(() => null) as { runs?: ResearchRunSummary[] } | null;
        if (!response.ok) throw new Error(errorMessage(data, "恢复研发任务失败"));
        if (!active) return;
        const run = data?.runs?.[0];
        if (!run) return;
        const nestedTarget = run.brief.target && typeof run.brief.target === "object"
          ? run.brief.target as Record<string, unknown>
          : run.brief;
        const restoredTimeframe = String(nestedTarget.timeframe ?? "").toLowerCase();
        const restoredDirection = String(nestedTarget.direction ?? "").toLowerCase();
        setRunId(run.id);
        setMode(run.mode);
        setInstrumentBusy(true);
        setAccountId(run.exchangeAccountId);
        setInstrumentId(String(nestedTarget.instrumentId ?? ""));
        if (timeframes.includes(restoredTimeframe as Timeframe)) setTimeframe(restoredTimeframe as Timeframe);
        if (directions.some(item => item.id === restoredDirection)) setDirection(restoredDirection as Direction);
        setTargetConfirmed(Boolean(run.exchangeAccountId && nestedTarget.instrumentId && restoredTimeframe && restoredDirection));
        setBusy(!terminalRunStatuses.has(run.status));
      })
      .catch(error => {
        if (active) setMessage(error instanceof Error ? error.message : "恢复研发任务失败");
      })
      .finally(() => {
        if (active) setRestoringRun(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    fetch(`/api/exchange-accounts/${encodeURIComponent(accountId)}/perpetual-instruments?quote=USDT`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async response => {
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, "读取永续合约失败"));
      const next = Array.isArray(data?.instruments) ? data.instruments as ResearchInstrument[] : [];
      setInstruments(next);
      if (!next.length) setInstrumentError("该账户当前没有可用的 USDT 永续合约");
      const preferredSymbol = String(brief.symbol ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
      const preferred = next.find(item => item.symbol === preferredSymbol);
      setInstrumentId(current => current && next.some(item => item.exchangeSymbol === current)
        ? current
        : preferred?.exchangeSymbol || "");
      const preferredTimeframe = String(brief.timeframe ?? "").toLowerCase();
      if (timeframes.includes(preferredTimeframe as Timeframe)) setTimeframe(current => current || preferredTimeframe as Timeframe);
      const preferredDirection = String(brief.direction ?? "").toLowerCase();
      if (directions.some(item => item.id === preferredDirection)) setDirection(current => current || preferredDirection as Direction);
    }).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setInstruments([]);
      setInstrumentError(error instanceof Error ? error.message : "读取永续合约失败");
    }).finally(() => {
      if (!controller.signal.aborted) setInstrumentBusy(false);
    });
    return () => controller.abort();
  }, [accountId, brief.direction, brief.symbol, brief.timeframe, instrumentRetry]);

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
      const nextPayload = data as RunPayload;
      setPayload(nextPayload);
      const missingFields = nextPayload.run.result?.requirements?.missingFields || [];
      if (nextPayload.run.status === "awaiting_user_input" && missingFields.length) {
        setInputAnswers(previous => Object.keys(previous).length ? previous : Object.fromEntries(
          missingFields.map(field => [field.key, field.defaultValue ?? field.options[0] ?? ""]),
        ));
      }
      const status = String(nextPayload.run.status);
      setBusy(!terminalRunStatuses.has(status));
    };
    void load();
    const source = new EventSource(`/api/strategy-research/runs/${encodeURIComponent(runId)}/events?afterSequence=0`);
    source.addEventListener("update", () => void load());
    source.addEventListener("done", () => { void load(); source.close(); });
    const timer = setInterval(() => void load(), 10_000);
    return () => { active = false; source.close(); clearInterval(timer); };
  }, [runId]);

  const activeDeploymentId = activeDeployment?.id ?? "";
  useEffect(() => {
    if (!activeDeploymentId) return;
    let active = true;
    const load = async () => {
      const [deploymentResponse, cyclesResponse] = await Promise.all([
        fetch(`/api/strategy-deployments/${encodeURIComponent(activeDeploymentId)}`, { cache: "no-store" }),
        fetch(`/api/strategy-deployments/${encodeURIComponent(activeDeploymentId)}/cycles?afterSequence=0`, { cache: "no-store" }),
      ]);
      const [deploymentData, cyclesData] = await Promise.all([
        deploymentResponse.json().catch(() => null),
        cyclesResponse.json().catch(() => null),
      ]);
      if (!active) return;
      if (deploymentResponse.ok && deploymentData?.deployment) {
        setActiveDeployment(deploymentData.deployment as ActiveDeployment);
      }
      if (cyclesResponse.ok && Array.isArray(cyclesData?.cycles)) {
        setRuntimeCycles(cyclesData.cycles as RuntimeCycle[]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [activeDeploymentId]);

  const evaluationByCandidate = useMemo(() => {
    const map = new Map<string, Evaluation>();
    for (const evaluation of payload?.evaluations || []) {
      if (evaluation.finalHoldout || (!map.has(evaluation.candidateId) && evaluation.kind === "validation_variant")) map.set(evaluation.candidateId, evaluation);
    }
    return map;
  }, [payload]);

  const selectedAccount = accounts.find(account => account.id === accountId);
  const selectedInstrument = instruments.find(instrument => instrument.exchangeSymbol === instrumentId);
  const targetReady = Boolean(selectedAccount && selectedInstrument && timeframe && direction && targetConfirmed);

  async function start() {
    if (!accountId) { setMessage("请先连接一个具有只读权限的 OKX、Binance 或 Bybit 账户"); return; }
    if (!selectedInstrument || !timeframe || !direction) { setMessage("请完整选择永续合约、周期和交易方向"); return; }
    if (!targetConfirmed) { setMessage("请确认本次研发条件后再启动"); return; }
    setBusy(true); setMessage(""); setPayload(null);
    setInputAnswers({});
    try {
      const response = await fetch("/api/strategy-research/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          exchangeAccountId: accountId,
          mode,
          target: {
            instrumentId: selectedInstrument.exchangeSymbol,
            symbol: selectedInstrument.symbol,
            timeframe,
            direction,
          },
          brief: { ...brief, symbol: selectedInstrument.symbol, timeframe, direction },
        }),
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
    setPayload(current => current ? {
      ...current,
      candidates: current.candidates.map(item => item.id === candidate.id ? {
        ...item,
        savedStrategyId: String(data.strategyId),
        savedStrategyVersionId: String(data.versionId),
      } : item),
    } : current);
    setMessage(data.simulationOnly ? "已保存到我的策略；该候选仅可用于模拟盘。" : "已保存到我的策略；已保留标准验证标签。");
  }

  async function deploy(candidate: Candidate, deploymentMode: "shadow" | "paper") {
    if (!candidate.savedStrategyId || !candidate.savedStrategyVersionId || !accountId) {
      setMessage("请先保存策略并选择行情数据账户。");
      return;
    }
    const risk = candidate.dsl.risk && typeof candidate.dsl.risk === "object" ? candidate.dsl.risk as Record<string, unknown> : {};
    const legs = candidate.dsl.legs && typeof candidate.dsl.legs === "object" ? candidate.dsl.legs as Record<string, unknown> : {};
    const stopLosses = Object.values(legs).flatMap(leg => leg && typeof leg === "object" ? [Number((leg as Record<string, unknown>).stopLossPct)] : []).filter(Number.isFinite);
    setDeployBusy(`${candidate.id}:${deploymentMode}`);
    const response = await fetch(`/api/strategies/${encodeURIComponent(candidate.savedStrategyId)}/versions/${encodeURIComponent(candidate.savedStrategyVersionId)}/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        exchangeAccountId: accountId,
        mode: deploymentMode,
        riskAcknowledged: true,
        positionSizePct: Number(risk.positionSizePct),
        stopLossPct: Math.max(...stopLosses),
      }),
    });
    const data = await response.json().catch(() => null);
    setDeployBusy("");
    if (response.ok && data?.deployment) {
      setActiveDeployment(data.deployment as ActiveDeployment);
      setRuntimeCycles([]);
    }
    setMessage(response.ok
      ? `${deploymentMode === "shadow" ? "影子运行" : "模拟盘"}已启动；真实订单路由保持关闭。`
      : errorMessage(data, "策略部署失败"));
  }

  async function controlDeployment(action: "pause" | "resume") {
    if (!activeDeployment) return;
    const response = await fetch(`/api/strategy-deployments/${encodeURIComponent(activeDeployment.id)}/${action}`, { method: "POST" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.deployment) {
      setMessage(errorMessage(data, action === "pause" ? "暂停部署失败" : "恢复部署失败"));
      return;
    }
    setActiveDeployment(data.deployment as ActiveDeployment);
    setMessage(action === "pause" ? "运行已暂停，不会继续处理新的完整 K 线。" : "运行已恢复，Runtime Worker 将继续处理完整 K 线。");
  }

  async function answerRequirements() {
    if (!runId) return;
    setAnswerBusy(true);
    const response = await fetch(`/api/strategy-research/runs/${encodeURIComponent(runId)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: inputAnswers }),
    });
    const data = await response.json().catch(() => null);
    setAnswerBusy(false);
    if (!response.ok) { setMessage(errorMessage(data, "补充条件失败")); return; }
    setInputAnswers({});
    setMessage("研发条件已补充，需求 Agent 将重新核对后自动继续。");
  }

  return <section className="multi-agent-research">
    <header><div><small>MULTI-AGENT RESEARCH</small><h3>多 Agent 策略研发与验证</h3><p>模型负责提出与审查，参数搜索、真实历史回测、评分和准入由确定性引擎完成。切换页面后，后台研发任务会继续运行。</p></div><span className={ready ? "ready" : "waiting"}>{ready ? "7 个角色已配置" : "等待角色配置"}</span></header>
    <div className="research-role-strip">{roles.map(role => <span key={role.role}><b>{roleNames[role.role] || role.role}</b><small>{role.modelName}</small></span>)}</div>
    <div className="research-launch-grid">
      <div className="research-mode-grid">{modes.map(item => <button type="button" className={mode === item.id ? "selected" : ""} key={item.id} onClick={() => { setMode(item.id); setTargetConfirmed(false); }}><b>{item.name}</b><small>{item.detail}</small></button>)}</div>
      <label>交易所与数据账户<select value={accountId} onChange={event => { const value = event.target.value; setAccountId(value); setInstruments([]); setInstrumentId(""); setInstrumentBusy(Boolean(value)); setInstrumentError(""); setTargetConfirmed(false); }}><option value="">请选择只读交易所账户</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label} · {account.exchange}</option>)}</select></label>
      <label className="research-instrument-field">USDT 永续合约<select value={instrumentId} disabled={!accountId || instrumentBusy || Boolean(instrumentError)} onChange={event => { setInstrumentId(event.target.value); setTargetConfirmed(false); }}><option value="">{instrumentBusy ? "正在读取真实合约…" : instrumentError ? "合约读取失败" : "请选择永续合约"}</option>{instruments.map(instrument => <option key={instrument.exchangeSymbol} value={instrument.exchangeSymbol}>{instrument.symbol} · tick {instrument.tickSize}</option>)}</select>{instrumentError && <span role="alert">{instrumentError}<button type="button" onClick={() => { setInstrumentBusy(true); setInstrumentError(""); setInstrumentRetry(value => value + 1); }}>重新读取合约</button></span>}</label>
      <label>K 线周期<select value={timeframe} onChange={event => { setTimeframe(event.target.value as Timeframe); setTargetConfirmed(false); }}><option value="">请选择周期</option>{timeframes.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>交易方向<select value={direction} onChange={event => { setDirection(event.target.value as Direction); setTargetConfirmed(false); }}><option value="">请选择交易方向</option>{directions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <section className="research-target-confirmation" aria-label="研发条件确认">
        <div><small>本次研发条件</small><b>{selectedAccount?.exchange || "未选平台"} · {selectedInstrument?.symbol || "未选合约"} · {timeframe || "未选周期"} · {directions.find(item => item.id === direction)?.label || "未选方向"} · {modes.find(item => item.id === mode)?.name}</b></div>
        <label><input type="checkbox" checked={targetConfirmed} disabled={!selectedAccount || !selectedInstrument || !timeframe || !direction} onChange={event => setTargetConfirmed(event.target.checked)} />我已核对平台、账户、合约、周期、方向和模式</label>
      </section>
      <div className="research-launch-actions"><button className="primary" disabled={busy || restoringRun || !ready || !targetReady} onClick={() => void start()}>{restoringRun ? "正在恢复最近的研发任务…" : busy ? "后台研发中…" : "启动多 Agent 研发"}</button>{busy && <button onClick={() => void cancel()}>取消任务</button>}</div>
    </div>
    {message && <p className="research-message">{message}</p>}
    {activeDeployment && <section className="research-runtime-panel" aria-label="策略运行周期">
      <header>
        <div><small>DETERMINISTIC RUNTIME</small><b>{activeDeployment.mode === "shadow" ? "影子运行" : "模拟盘"} · {activeDeployment.status}</b><p>版本 {activeDeployment.strategyVersionId.slice(0, 12)} · 真实订单路由关闭</p></div>
        {activeDeployment.status === "active"
          ? <button type="button" onClick={() => void controlDeployment("pause")}>暂停运行</button>
          : activeDeployment.status === "paused" && <button type="button" onClick={() => void controlDeployment("resume")}>恢复运行</button>}
      </header>
      {runtimeCycles.length === 0 ? <p className="research-runtime-empty">等待 Runtime Worker 处理下一根已完成 K 线；信号确认后在下一根开盘模拟成交。</p> : (() => {
        const latest = runtimeCycles.at(-1);
        return latest ? <div className="research-runtime-cycle">
          <div className="research-runtime-summary"><span>周期 #{latest.sequence}</span><b>{latest.decision.action || "hold"}</b><small>{new Date(latest.candleCloseTime).toLocaleString("zh-CN")}</small><code>{latest.traceId}</code></div>
          <div className="research-runtime-events">{latest.events.map(event => <article key={`${latest.id}:${event.sequence}`}>
            <i>{event.sequence}</i><div><span>{roleNames[event.role] || event.role}</span><b>{event.conclusion}</b><small>确定性模块 · {event.durationMs}ms</small>
              {event.explanationStatus === "completed" && event.explanation && <section className="runtime-explanation"><em>异步解释 · {event.explanationModelName || event.modelName} · {event.explanationDurationMs ?? 0}ms</em><p>{event.explanation.summary}</p>{event.explanation.cautions.length > 0 && <small>{event.explanation.cautions.join("；")}</small>}</section>}
              {["pending", "running", "retry_wait"].includes(event.explanationStatus) && <em className="runtime-explanation-progress">异步解释 {event.explanationStatus === "retry_wait" ? "等待重试" : "生成中"}<i>•••</i></em>}
              {event.explanationStatus === "failed" && <em className="runtime-explanation-failed">异步解释失败（{event.explanationErrorCode}），不影响本周期结论</em>}
            </div>
          </article>)}</div>
        </div> : null;
      })()}
    </section>}
    {payload && <>
      <div className="research-progress"><span><i style={{ width: `${payload.run.progress}%` }} /></span><b>{payload.run.progress}%</b><em>{payload.run.stage} · {payload.run.status}</em></div>
      {payload.run.status === "awaiting_user_input" && (payload.run.result?.requirements?.missingFields || []).length > 0 && <section className="research-input-request">
        <header><b>需要你补充几个关键条件</b><p>这里只追问会改变策略和回测结论的条件。</p></header>
        {(payload.run.result?.requirements?.missingFields || []).map(field => <label key={field.key}>
          <span>{field.question}</span>
          {field.options.length > 0 && <div>{field.options.map(option => <button type="button" className={inputAnswers[field.key] === option ? "selected" : ""} key={String(option)} onClick={() => setInputAnswers(current => ({ ...current, [field.key]: option }))}>{String(option)}</button>)}</div>}
          <input value={String(inputAnswers[field.key] ?? "")} onChange={event => setInputAnswers(current => ({ ...current, [field.key]: event.target.value }))} />
        </label>)}
        <button className="primary" disabled={answerBusy} onClick={() => void answerRequirements()}>{answerBusy ? "正在提交…" : "确认条件并继续研发"}</button>
      </section>}
      <div className="research-timeline">{payload.events.map(event => <article key={event.id}><i>{event.sequence}</i><div><small>{roleNames[event.role] || event.role}</small><b>{event.title}</b><p>{String(event.content.conclusion || event.content.summary || "阶段结果已结构化保存")}</p></div></article>)}</div>
      {payload.candidates.length > 0 && <div className="research-candidates">{payload.candidates.filter(candidate => candidate.rank != null).slice(0, 3).map(candidate => {
        const evaluation = evaluationByCandidate.get(candidate.id);
        return <article key={candidate.id} className={candidate.validationLabel === "STANDARD_VERIFIED" ? "verified" : "failed"}>
          <header><b>#{candidate.rank} {candidate.strategyFamily}</b><span>{candidate.validationLabel}</span></header>
          <div><span>评分<b>{candidate.score?.toFixed(2) ?? "—"}</b></span><span>样本外收益<b>{evaluation?.metrics.netReturnPct == null ? "—" : `${evaluation.metrics.netReturnPct > 0 ? "+" : ""}${evaluation.metrics.netReturnPct.toFixed(2)}%`}</b></span><span>最大回撤<b>{evaluation?.metrics.maxDrawdownPct == null ? "—" : `${evaluation.metrics.maxDrawdownPct.toFixed(2)}%`}</b></span><span>交易数<b>{evaluation?.metrics.sampleSize ?? "—"}</b></span></div>
          {candidate.rejectionReasons.length > 0 && <ul>{candidate.rejectionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <button disabled={Boolean(candidate.savedStrategyId)} onClick={() => void save(candidate)}>{candidate.savedStrategyId ? "已保存到我的策略" : "保存到我的策略"}</button>
          {candidate.savedStrategyId && <div className="research-deploy-actions"><button disabled={Boolean(deployBusy)} onClick={() => void deploy(candidate, "shadow")}>{deployBusy === `${candidate.id}:shadow` ? "启动中…" : "启动影子运行"}</button><button disabled={Boolean(deployBusy)} onClick={() => void deploy(candidate, "paper")}>{deployBusy === `${candidate.id}:paper` ? "启动中…" : "启动模拟盘"}</button></div>}
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
