"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "./backtest.module.css";

export type StrategyBacktestSummary = {
  id: string;
  name: string;
  version: number;
  symbols: string[];
  status: string;
  createdAt?: string;
};

type CompletedTrade = {
  openedAt: number;
  closedAt: number;
  netPnl: number;
  returnPct: number;
  reason: string;
};

type BacktestResult = {
  provider?: string;
  periodStart?: string;
  periodEnd?: string;
  candleCount?: number;
  sampleSize?: number;
  netReturnPct?: number;
  maxDrawdownPct?: number;
  winRatePct?: number;
  profitFactor?: number;
  finalEquityUsdt?: number;
  warnings?: string[];
  trades?: CompletedTrade[];
  parameters?: { initialEquityUsdt?: number };
};

type ProgressEvent = {
  type: "progress";
  stage: "validating" | "market_data" | "funding" | "engine" | "saving";
  progress: number;
  message: string;
};

type CompletedEvent = {
  type: "completed";
  progress: 100;
  reportId: string;
  result: BacktestResult;
  message: string;
};

type FailedEvent = {
  type: "failed";
  progress: number;
  error: { code: string; message: string };
};

const stages: Array<{ id: ProgressEvent["stage"]; label: string }> = [
  { id: "validating", label: "校验策略" },
  { id: "market_data", label: "读取行情" },
  { id: "funding", label: "核对成本" },
  { id: "engine", label: "运行引擎" },
  { id: "saving", label: "保存报告" },
];

const defaultOptions = {
  preset: "live_aligned" as const,
  initialEquityUsdt: 10_000,
  feeRate: 0.001,
  slippageRate: 0.0005,
  candleLimit: 1_000,
};

function apiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || fallback);
  }
  return fallback;
}

function numberText(value: number | undefined, suffix = "") {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}${suffix}` : "—";
}

function dateText(value: string | number | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function equityCurvePoints(result: BacktestResult, width = 900, height = 260) {
  const initial = Number(result.parameters?.initialEquityUsdt || 10_000);
  const values = [initial];
  for (const trade of result.trades || []) values.push(values.at(-1)! + trade.netPnl);
  if (values.length === 1) values.push(Number(result.finalEquityUsdt || initial));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, initial * 0.005, 1);
  return values.map((value, index) => {
    const x = 18 + index / Math.max(values.length - 1, 1) * (width - 36);
    const y = 18 + (max - value) / span * (height - 36);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

async function latestBacktest(strategyId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/strategy-marketplace/${encodeURIComponent(strategyId)}`, { cache: "no-store", signal });
  const payload = await response.json().catch(() => null) as { backtests?: Array<{ metrics?: BacktestResult }> } | null;
  if (!response.ok) throw new Error(apiError(payload, "回测报告加载失败"));
  return payload?.backtests?.[0]?.metrics || null;
}

export function StrategyBacktestCenter({
  strategies,
  initialStrategyId,
  autoStart = false,
  onBack,
  onOpenDetail,
  onUpdated,
}: {
  strategies: StrategyBacktestSummary[];
  initialStrategyId?: string;
  autoStart?: boolean;
  onBack: () => void;
  onOpenDetail: (strategyId: string) => void;
  onUpdated?: () => void;
}) {
  const [strategyId, setStrategyId] = useState(initialStrategyId || strategies[0]?.id || "");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<ProgressEvent["stage"] | "idle" | "completed" | "failed">("idle");
  const [statusMessage, setStatusMessage] = useState("选择策略后可运行真实历史数据回测");
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);
  const selected = strategies.find(item => item.id === strategyId);

  useEffect(() => {
    if (!strategyId) return;
    const controller = new AbortController();
    latestBacktest(strategyId, controller.signal)
      .then(setResult)
      .catch(error => {
        if (!(error instanceof Error && error.name === "AbortError")) setStatusMessage(error instanceof Error ? error.message : "回测报告加载失败");
      });
    return () => controller.abort();
  }, [strategyId]);

  const runBacktest = useCallback(async () => {
    if (!strategyId || busy) return;
    setBusy(true);
    setResult(null);
    setProgress(2);
    setStage("validating");
    setStatusMessage("正在建立回测任务…");
    try {
      const response = await fetch(`/api/strategy-marketplace/${encodeURIComponent(strategyId)}/backtest?stream=1`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify(defaultOptions),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(apiError(payload, "回测任务启动失败"));
      }

      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let failure = "";
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as ProgressEvent | CompletedEvent | FailedEvent;
        if (event.type === "progress") {
          setStage(event.stage);
          setProgress(event.progress);
          setStatusMessage(event.message);
        } else if (event.type === "completed") {
          setStage("completed");
          setProgress(100);
          setResult(event.result);
          setStatusMessage(event.message);
        } else {
          failure = event.error.message;
          setStage("failed");
          setProgress(event.progress);
          setStatusMessage(event.error.message);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) consume(line);
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
      if (failure) throw new Error(failure);
      onUpdated?.();
    } catch (error) {
      setStage("failed");
      setStatusMessage(error instanceof Error ? error.message : "历史回测失败");
    } finally {
      setBusy(false);
    }
  }, [busy, onUpdated, strategyId]);

  useEffect(() => {
    if (!autoStart || autoStarted.current || !strategyId) return;
    autoStarted.current = true;
    void runBacktest();
  }, [autoStart, runBacktest, strategyId]);

  const curve = useMemo(() => result ? equityCurvePoints(result) : "", [result]);
  const currentStageIndex = stages.findIndex(item => item.id === stage);

  return <div className={styles.page}>
    <header className={styles.header}>
      <button type="button" onClick={onBack}>返回策略列表</button>
      <div><small>VISUAL BACKTEST LAB</small><h2>历史回测中心</h2><p>查看真实运行阶段、资金曲线和逐笔结果；历史表现不代表未来收益。</p></div>
      <span>不会创建真实订单</span>
    </header>

    <nav className={styles.tabs} aria-label="策略工作区">
      <button type="button" onClick={onBack}><b>策略列表</b><small>版本、审核与分享</small></button>
      <button type="button" className={styles.active} aria-current="page"><b>回测与模拟</b><small>历史回测可视化</small></button>
    </nav>

    <section className={styles.controlDeck}>
      <div>
        <label>选择策略<select value={strategyId} disabled={busy} onChange={event => { setStrategyId(event.target.value); setStage("idle"); setProgress(0); }}><option value="">请选择策略</option>{strategies.map(strategy => <option key={strategy.id} value={strategy.id}>{strategy.name} · V{strategy.version}</option>)}</select></label>
        <p>{selected ? `${selected.symbols.join(" · ")} · 创建于 ${dateText(selected.createdAt)}` : "先从策略列表选择一个版本"}</p>
      </div>
      <div className={styles.controlActions}>
        <button type="button" onClick={() => strategyId && onOpenDetail(strategyId)} disabled={!strategyId || busy}>查看规则</button>
        <button type="button" className={styles.primary} onClick={() => void runBacktest()} disabled={!strategyId || busy}>{busy ? "回测运行中" : "开始历史回测"}</button>
      </div>
    </section>

    <section className={styles.liveStatus} data-stage={stage} aria-live="polite">
      <div className={styles.progressHeading}><div><small>RUN STATUS</small><b>{statusMessage}</b></div><strong>{progress}%</strong></div>
      <div className={styles.progressTrack}><i style={{ width: `${progress}%` }} /></div>
      <div className={styles.stageList}>{stages.map((item, index) => <span key={item.id} className={stage === "completed" || index < currentStageIndex ? "done" : item.id === stage ? "running" : ""}><i>{stage === "completed" || index < currentStageIndex ? "✓" : index + 1}</i>{item.label}</span>)}</div>
    </section>

    <div className={styles.visualGrid}>
      <section className={styles.equityChart}>
        <header><div><small>EQUITY CURVE</small><h3>资金曲线</h3></div><span>{result ? `${result.sampleSize || 0} 笔已完成交易` : "等待回测结果"}</span></header>
        {result ? <>
          <svg viewBox="0 0 900 260" role="img" aria-label="回测资金曲线">
            <defs><linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4ba8ff" stopOpacity=".32"/><stop offset="1" stopColor="#4ba8ff" stopOpacity="0"/></linearGradient></defs>
            <line x1="18" y1="242" x2="882" y2="242" />
            <polyline points={curve} fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className={styles.chartCaption}><span>{dateText(result.periodStart)}</span><span>{dateText(result.periodEnd)}</span></div>
        </> : <div className={styles.chartEmpty}><i /><p>{busy ? "回测引擎完成后将在这里绘制真实资金曲线" : "运行回测后显示逐笔权益变化，不使用演示数据"}</p></div>}
      </section>

      <aside className={styles.card}>
        <small>PAPER RUNTIME</small><h3>模拟运行</h3><p>历史回测用于验证过去；模拟运行按新完成的 K 线持续生成信号，两者不会混成一份结果。</p>
        <ul><li>固定策略版本</li><li>七模块决策时间线</li><li>真实订单路由关闭</li></ul>
        <span>模拟盘从通过保存的研发候选启动</span>
      </aside>
    </div>

    {result && <section className={styles.panel}>
      <div className={styles.metrics}>
        <span>净收益<b className={Number(result.netReturnPct || 0) >= 0 ? "up" : "down"}>{numberText(result.netReturnPct, "%")}</b></span>
        <span>最大回撤<b>{numberText(result.maxDrawdownPct, "%")}</b></span>
        <span>胜率<b>{numberText(result.winRatePct, "%")}</b></span>
        <span>盈亏因子<b>{numberText(result.profitFactor)}</b></span>
        <span>期末权益<b>{numberText(result.finalEquityUsdt, " USDT")}</b></span>
      </div>
      {Boolean(result.warnings?.length) && <div className={styles.warnings}>{result.warnings?.map(warning => <p key={warning}>提示：{warning}</p>)}</div>}
      <div className={styles.tradeFeed}><header><h3>最近完成交易</h3><span>{result.provider || "平台行情引擎"} · {result.candleCount || 0} 根 K 线</span></header>{result.trades?.length ? result.trades.slice(-8).reverse().map(trade => <div key={`${trade.openedAt}:${trade.closedAt}`}><span>{dateText(trade.closedAt)}</span><b className={trade.netPnl >= 0 ? "up" : "down"}>{numberText(trade.netPnl, " USDT")}</b><small>{trade.reason}</small></div>) : <p>本次没有已完成交易，请检查信号触发频率与规则边界。</p>}</div>
    </section>}
  </div>;
}
