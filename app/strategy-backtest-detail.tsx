"use client";

import { useCallback, useEffect, useState } from "react";
import type { StrategyDsl } from "@/packages/domain/src/strategy-dsl";

type CompletedTrade = {
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  netPnl: number;
  returnPct: number;
  reason: string;
};

type BacktestMetrics = {
  provider?: string;
  periodStart?: string;
  periodEnd?: string;
  candleCount?: number;
  sampleSize?: number;
  netReturnPct?: number;
  maxDrawdownPct?: number;
  winRatePct?: number;
  profitFactor?: number;
  feesUsdt?: number;
  slippageUsdt?: number;
  finalEquityUsdt?: number;
  warnings?: string[];
  evidenceRef?: string;
  trades?: CompletedTrade[];
  parameters?: {
    preset?: "live_aligned" | "exploration";
    feeRate?: number;
    slippageRate?: number;
    initialEquityUsdt?: number;
    candleLimit?: number;
  };
};

type StrategyDetailPayload = {
  strategy: {
    id: string;
    name: string;
    summary: string;
    status: string;
    version: number;
    symbols: string[];
    riskLevel: string;
    publicationMode: string;
    specification: StrategyDsl;
    updatedAt: string;
  };
  versions: Array<{
    id: string;
    version: number;
    source: string;
    restoredFromVersion?: number | null;
    createdAt: string;
  }>;
  backtests: Array<{
    id: string;
    strategyVersion: number;
    createdAt: string;
    metrics: BacktestMetrics;
  }>;
};

type BacktestOptions = {
  preset: "live_aligned" | "exploration";
  initialEquityUsdt: number;
  feeRate: number;
  slippageRate: number;
  candleLimit: number;
};

const defaultOptions: BacktestOptions = {
  preset: "live_aligned",
  initialEquityUsdt: 10_000,
  feeRate: 0.001,
  slippageRate: 0.0005,
  candleLimit: 1_000,
};

function apiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" ? error : fallback;
}

function numberText(value: number | undefined, suffix = "") {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}${suffix}` : "—";
}

function dateText(value: string | number | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

async function fetchStrategyDetail(strategyId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/strategy-marketplace/${encodeURIComponent(strategyId)}`, {
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => null) as StrategyDetailPayload | null;
  if (!response.ok || !payload?.strategy) throw new Error(apiError(payload, "策略详情加载失败"));
  return payload;
}

function previousBacktestOptions(payload: StrategyDetailPayload, current: BacktestOptions): BacktestOptions {
  const previous = payload.backtests[0]?.metrics.parameters;
  if (!previous) return current;
  return {
    preset: previous.preset === "exploration" ? "exploration" : "live_aligned",
    initialEquityUsdt: previous.initialEquityUsdt ?? current.initialEquityUsdt,
    feeRate: previous.feeRate ?? current.feeRate,
    slippageRate: previous.slippageRate ?? current.slippageRate,
    candleLimit: previous.candleLimit ?? current.candleLimit,
  };
}

export function StrategyBacktestDetail({
  strategyId,
  onBack,
  onUpdated,
}: {
  strategyId: string;
  onBack: () => void;
  onUpdated?: () => void;
}) {
  const [detail, setDetail] = useState<StrategyDetailPayload | null>(null);
  const [options, setOptions] = useState<BacktestOptions>(defaultOptions);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const payload = await fetchStrategyDetail(strategyId, signal);
    setDetail(payload);
    setOptions((current) => previousBacktestOptions(payload, current));
  }, [strategyId]);

  useEffect(() => {
    const controller = new AbortController();
    fetchStrategyDetail(strategyId, controller.signal)
      .then((payload) => {
        setDetail(payload);
        setOptions((current) => previousBacktestOptions(payload, current));
      })
      .catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setMessage(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [strategyId]);

  function selectPreset(preset: BacktestOptions["preset"]) {
    setOptions((current) => ({
      ...current,
      preset,
      feeRate: 0.001,
      slippageRate: preset === "live_aligned" ? 0.0005 : 0,
    }));
  }

  async function runBacktest() {
    setBusy(true);
    setMessage("正在加载历史 K 线并计算交易成本、回撤和逐笔交易…");
    try {
      const response = await fetch(`/api/strategy-marketplace/${encodeURIComponent(strategyId)}/backtest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      });
      const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
      if (!response.ok) throw new Error(apiError(payload, "历史回测失败"));
      await refresh();
      onUpdated?.();
      setMessage(payload?.message || "历史回测已完成并保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "历史回测失败");
    } finally {
      setBusy(false);
    }
  }

  async function rollbackVersion(sourceVersion: number) {
    if (!detail || busy || sourceVersion === detail.strategy.version) return;
    const nextVersion = detail.strategy.version + 1;
    if (!window.confirm(`确认回滚到 V${sourceVersion}？\n\n系统不会覆盖历史记录，而是将生成新的 V${nextVersion}。`)) return;
    setBusy(true);
    setMessage(`正在将 V${sourceVersion} 恢复为新的 V${nextVersion}…`);
    try {
      const response = await fetch(`/api/strategy-marketplace/${encodeURIComponent(strategyId)}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceVersion }),
      });
      const payload = await response.json().catch(() => null) as { message?: string; error?: string; version?: number } | null;
      if (!response.ok) throw new Error(apiError(payload, "策略版本回滚失败"));
      await refresh();
      onUpdated?.();
      setMessage(payload?.message || `已将 V${sourceVersion} 恢复为新的 V${payload?.version || nextVersion}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "策略版本回滚失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !detail) return <div className="strategy-detail-page"><button onClick={onBack}>返回我的策略</button><div className="notice">正在加载策略详情…</div></div>;
  if (!detail) return <div className="strategy-detail-page"><button onClick={onBack}>返回我的策略</button><div className="notice">{message || "策略详情不可用"}</div></div>;

  const { strategy } = detail;
  const latest = detail.backtests[0]?.metrics;
  const canBacktest = ["draft", "testing", "rejected"].includes(strategy.status);
  const canChangeVersion = ["draft", "testing", "rejected"].includes(strategy.status);

  return <div className="strategy-detail-page">
    <header className="strategy-detail-header">
      <button onClick={onBack}>返回我的策略</button>
      <div><small>STRATEGY RESEARCH RECORD</small><h2>{strategy.name}</h2><p>{strategy.summary}</p></div>
      <span>{strategy.publicationMode === "self_use" ? "自用策略" : strategy.status} · V{strategy.version}</span>
    </header>
    {message && <div className="notice">{message}</div>}

    <div className="strategy-detail-grid">
      <section className="strategy-rule-card">
        <div className="strategy-detail-title"><div><small>VALIDATED DSL</small><h3>策略规则</h3></div><span>{strategy.symbols.join(" · ")}</span></div>
        <dl>
          <div><dt>周期</dt><dd>{strategy.specification.timeframe}</dd></div>
          <div><dt>方向</dt><dd>{strategy.specification.side === "long_only" ? "仅做多" : strategy.specification.side}</dd></div>
          <div><dt>单次仓位</dt><dd>{strategy.specification.risk.positionPct}%</dd></div>
          <div><dt>最大回撤</dt><dd>{strategy.specification.risk.maxDrawdownPct}%</dd></div>
          <div><dt>止损</dt><dd>{strategy.specification.exit.stopLossPct}%</dd></div>
          <div><dt>止盈</dt><dd>{strategy.specification.exit.takeProfitPct}%</dd></div>
        </dl>
        <details><summary>查看完整 JSON DSL</summary><pre>{JSON.stringify(strategy.specification, null, 2)}</pre></details>
      </section>

      <section className="strategy-backtest-config">
        <div className="strategy-detail-title"><div><small>BACKTEST CONFIG</small><h3>回测预设</h3></div><span>参数会写入报告</span></div>
        <div className="backtest-preset-choice">
          <button className={options.preset === "live_aligned" ? "selected" : ""} onClick={() => selectPreset("live_aligned")}><b>实盘对齐</b><span>计入默认手续费与滑点，更接近执行成本</span></button>
          <button className={options.preset === "exploration" ? "selected" : ""} onClick={() => selectPreset("exploration")}><b>探索研究</b><span>默认不计滑点，用于观察规则敏感度</span></button>
        </div>
        <div className="backtest-option-grid">
          <label>初始资金（USDT）<input type="number" min="100" max="1000000" value={options.initialEquityUsdt} onChange={(event) => setOptions({ ...options, initialEquityUsdt: Number(event.target.value) })} /></label>
          <label>手续费（%）<input type="number" min="0" max="1" step="0.01" value={options.feeRate * 100} onChange={(event) => setOptions({ ...options, feeRate: Number(event.target.value) / 100 })} /></label>
          <label>滑点（%）<input type="number" min="0" max="2" step="0.01" value={options.slippageRate * 100} onChange={(event) => setOptions({ ...options, slippageRate: Number(event.target.value) / 100 })} /></label>
          <label>K线数量<input type="number" min="200" max="1000" step="100" value={options.candleLimit} onChange={(event) => setOptions({ ...options, candleLimit: Number(event.target.value) })} /></label>
        </div>
        <button className="primary" disabled={busy || !canBacktest} onClick={() => void runBacktest()}>{busy ? "回测运行中…" : canBacktest ? "运行并保存回测" : "当前状态不可回测"}</button>
        <p>回测只运行平台校验后的 JSON DSL，不执行任意代码，也不会创建真实订单。</p>
      </section>
    </div>

    <section className="strategy-report-section">
      <div className="strategy-detail-title"><div><small>SAVED RESULTS</small><h3>回测报告</h3></div><span>{detail.backtests.length} 份已保存报告</span></div>
      {latest ? <>
        <div className="strategy-report-metrics">
          <span>净收益<b>{numberText(latest.netReturnPct, "%")}</b></span>
          <span>最大回撤<b>{numberText(latest.maxDrawdownPct, "%")}</b></span>
          <span>胜率<b>{numberText(latest.winRatePct, "%")}</b></span>
          <span>盈亏因子<b>{numberText(latest.profitFactor)}</b></span>
          <span>交易样本<b>{latest.sampleSize ?? 0} 笔</b></span>
          <span>期末权益<b>{numberText(latest.finalEquityUsdt, " USDT")}</b></span>
        </div>
        <div className="strategy-report-evidence"><span>区间：{dateText(latest.periodStart)} — {dateText(latest.periodEnd)}</span><span>行情：{latest.provider || "平台行情引擎"} · {latest.candleCount || 0} 根</span><span>成本：手续费 {numberText(latest.feesUsdt)} / 滑点 {numberText(latest.slippageUsdt)} USDT</span><code>{latest.evidenceRef || "证据哈希不可用"}</code></div>
        {Boolean(latest.warnings?.length) && <div className="strategy-report-warnings">{latest.warnings?.map((warning) => <p key={warning}>提示：{warning}</p>)}</div>}
        <div className="strategy-trades"><h4>最近交易</h4>{latest.trades?.length ? <div className="strategy-trade-table"><div><b>开仓</b><b>平仓</b><b>入场价</b><b>退出价</b><b>净盈亏</b><b>原因</b></div>{latest.trades.slice(-10).reverse().map((trade) => <div key={`${trade.openedAt}-${trade.closedAt}`}><span>{dateText(trade.openedAt)}</span><span>{dateText(trade.closedAt)}</span><span>{numberText(trade.entryPrice)}</span><span>{numberText(trade.exitPrice)}</span><span className={trade.netPnl >= 0 ? "up" : "down"}>{numberText(trade.netPnl, " USDT")}</span><span>{trade.reason}</span></div>)}</div> : <p>当前区间没有产生已完成交易，请检查规则触发频率和样本区间。</p>}</div>
      </> : <div className="notice">尚未运行回测。选择预设与参数后，首份报告会保存在这里。</div>}
    </section>

    <section className="strategy-version-section">
      <div className="strategy-detail-title"><div><small>IMMUTABLE HISTORY</small><h3>版本记录</h3><p>每次调整自动增加版本号；回滚会复制历史规则并生成新的最新版本。</p></div><span>{detail.versions.length} 个版本</span></div>
      <div>{detail.versions.map((version) => {
        const currentVersion = version.version === strategy.version;
        const sourceLabel = version.restoredFromVersion
          ? `回滚自 V${version.restoredFromVersion}`
          : version.source === "ai_provider"
            ? "AI 服务生成"
            : version.source === "guided_rules"
              ? "平台规则生成"
              : "人工编辑";
        return <article key={version.id}>
          <b>V{version.version}</b>
          <span>{sourceLabel}</span>
          <time>{dateText(version.createdAt)}</time>
          {currentVersion
            ? <em>当前版本</em>
            : canChangeVersion
              ? <button aria-label={`回滚到 V${version.version}`} disabled={busy} onClick={() => void rollbackVersion(version.version)}>回滚到 V{version.version}</button>
              : <em>需先创建可编辑草稿</em>}
        </article>;
      })}</div>
    </section>
  </div>;
}
