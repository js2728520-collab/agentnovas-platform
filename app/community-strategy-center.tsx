"use client";

import { useEffect, useState } from "react";
import type { StrategyDetailData } from "./strategy-detail";
import { StrategyBacktestCenter, type StrategyBacktestSummary } from "./strategy-backtest-center";
import { StrategyBacktestDetail } from "./strategy-backtest-detail";
import MultiAgentResearch from "@/apps/client/ui/strategy-studio";

type Row = Record<string, unknown>;
type Studio = {
  name: string;
  publicationMode: "marketplace" | "self_use";
  symbol: string;
  period: string;
  style: string;
  risk: "low" | "medium" | "high";
  capital: string;
  stopLoss: string;
  takeProfit: string;
  maxDrawdown: string;
  indicators: string;
  entryRule: string;
  exitRule: string;
  riskRule: string;
};

const initial: Studio = {
  name: "",
  publicationMode: "marketplace",
  symbol: "BTC/USDT",
  period: "15m",
  style: "趋势跟随",
  risk: "medium",
  capital: "5",
  stopLoss: "2.0",
  takeProfit: "4.0",
  maxDrawdown: "12",
  indicators: "EMA20, EMA60, ADX14, ATR14",
  entryRule: "",
  exitRule: "",
  riskRule: "",
};

type FactorPreset = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  defaults: Partial<Studio>;
};

// These are deliberately conservative, well-known building blocks. They are
// suggestions for research, never promises of returns or ready-made advice.
const factorPresets: FactorPreset[] = [
  {
    id: "trend",
    title: "趋势跟随",
    summary: "适合有方向的行情，减少震荡期追单。",
    tags: ["EMA20/60", "ADX14", "ATR14"],
    defaults: {
      style: "趋势跟随",
      period: "4h",
      indicators: "EMA20, EMA60, ADX14, ATR14, 成交量MA20",
      entryRule: "EMA20 上穿 EMA60 且 ADX14 ≥ 22，收盘确认后入场；成交量不低于 MA20 的 85%。",
      exitRule: "EMA20 下穿 EMA60，或触发 2×ATR14 移动止损；不在单根异常长K线追单。",
      riskRule: "单笔风险 ≤ 0.5%，连续 3 笔亏损暂停 4 个周期；单日亏损达到 2% 停止开仓。",
    },
  },
  {
    id: "range",
    title: "区间反转",
    summary: "适合横盘市场，要求先过滤趋势行情。",
    tags: ["RSI14", "布林20/2", "ATR14"],
    defaults: {
      style: "区间交易",
      period: "1h",
      indicators: "RSI14, Bollinger20(2), ATR14, ADX14",
      entryRule: "ADX14 < 20 且价格触及布林带外轨；RSI14 < 30 做多、> 70 做空，下一根K线确认。",
      exitRule: "回到布林中轨分批止盈；RSI14 回到 50 或触发 1.5×ATR14 止损即退出。",
      riskRule: "单笔风险 ≤ 0.35%，同方向最多 1 个仓位；ADX14 ≥ 25 时暂停区间策略。",
    },
  },
  {
    id: "breakout",
    title: "突破动量",
    summary: "只在波动扩张和成交量确认时参与突破。",
    tags: ["Donchian20", "Volume", "ATR14"],
    defaults: {
      style: "突破动量",
      period: "1h",
      indicators: "Donchian20, Volume/MA20, ATR14, EMA20",
      entryRule: "收盘突破 Donchian20 上轨，成交量 ≥ MA20 的 1.5 倍，且 ATR14 处于过去 50 根的中位数以上。",
      exitRule: "跌回突破区间内退出；达到 3×ATR14 或移动止损后分批平仓。",
      riskRule: "单笔风险 ≤ 0.4%，突破后 2 根K线未延续则撤退；连续 2 次假突破暂停。",
    },
  },
  {
    id: "defensive",
    title: "防守轮动",
    summary: "优先控制回撤，适合低频组合研究。",
    tags: ["EMA120", "波动率", "相关性"],
    defaults: {
      style: "市场中性",
      period: "1D",
      indicators: "EMA120, ATR14, 20日波动率, 相关性过滤",
      entryRule: "价格位于 EMA120 上方且 20 日波动率低于阈值；通过相关性过滤后按等风险分配。",
      exitRule: "收盘跌破 EMA120 或波动率超过上限时减仓至 0；不使用追涨加仓。",
      riskRule: "单笔风险 ≤ 0.25%，总资金使用率 ≤ 30%，账户回撤达到 8% 进入保护模式。",
    },
  },
];

function factor(id: string, title: string, summary: string, tags: string[], indicators: string, entryRule: string, exitRule: string, riskRule: string): FactorPreset {
  return { id, title, summary, tags, defaults: { indicators, entryRule, exitRule, riskRule } };
}

const factorExtensions: FactorPreset[] = [
  factor("ema-cross", "EMA 双均线", "用快慢均线确认方向，减少逆势开仓。", ["EMA20", "EMA60", "收盘确认"], "EMA20, EMA60, ATR14", "EMA20 上穿 EMA60 且收盘站稳，下一根K线确认。", "EMA20 下穿 EMA60 或触发 ATR14 止损。", "单笔风险 ≤ 0.35%；连续 3 笔亏损暂停。"),
  factor("sma-regime", "SMA 长周期过滤", "用长周期均线过滤短线信号。", ["SMA50", "SMA200", "趋势过滤"], "SMA50, SMA200, ATR14", "价格位于 SMA200 上方且 SMA50 斜率为正时，只研究多头。", "收盘跌破 SMA50 或波动率超阈值退出。", "总资金使用率 ≤ 25%；不在均线附近加仓。"),
  factor("adx-strength", "ADX 趋势强度", "只在趋势强度足够时启用趋势策略。", ["ADX14", "+DI/-DI", "阈值"], "ADX14, +DI, -DI, ATR14", "ADX14 ≥ 22 且 +DI > -DI，价格完成收盘确认。", "ADX14 跌破 18 或 -DI 上穿 +DI 时退出。", "单笔风险 ≤ 0.4%；ADX 失效后冷却 4 个周期。"),
  factor("rsi-reversal", "RSI 超买超卖", "通过 RSI 极值和确认K线研究反转。", ["RSI14", "30/70", "反转"], "RSI14, ATR14, 支撑阻力", "RSI14 < 30 后重新上穿 30，且价格未跌破关键支撑。", "RSI14 回到 50 或触发 1.5×ATR14 止损。", "单笔风险 ≤ 0.25%；趋势强度过高时禁用反转。"),
  factor("macd-momentum", "MACD 动能", "确认动能方向，避免仅凭单根K线追单。", ["MACD", "Signal", "Histogram"], "MACD(12,26,9), EMA200, ATR14", "MACD 上穿 Signal 且柱体连续两根扩大，并通过 EMA200 方向过滤。", "MACD 反向交叉或柱体连续两根收缩时减仓。", "单笔风险 ≤ 0.35%；禁止在跳空或异常长K线入场。"),
  factor("bollinger-revert", "布林带回归", "适合低趋势强度的均值回归研究。", ["Bollinger20", "2σ", "ADX过滤"], "Bollinger20(2), RSI14, ADX14", "ADX14 < 20 且价格触及下轨后收回，RSI14 不再创新低。", "回到中轨分批止盈，触及外轨反向扩张时退出。", "单笔风险 ≤ 0.3%；ADX14 ≥ 25 自动停用。"),
  factor("stoch-reversal", "随机指标反转", "用交叉和区间位置辅助低频反转。", ["Stoch14", "K/D", "区间"], "Stochastic(14,3,3), RSI14, ATR14", "K 线在 20 以下上穿 D 线，并出现收盘确认。", "K 线在 80 以上下穿 D 线，或触发 ATR 止损。", "同一方向只保留 1 个仓位；单笔风险 ≤ 0.25%。"),
  factor("atr-volatility", "ATR 波动率仓位", "按波动率动态降低仓位，而不是放宽止损。", ["ATR14", "风险平价", "仓位"], "ATR14, ATR50, EMA20", "方向信号成立且 ATR14/ATR50 位于允许区间。", "ATR14 突增超过 2 倍中位数时减仓或退出。", "单笔风险固定 ≤ 0.35%；波动率越高仓位越小。"),
  factor("keltner-channel", "肯特纳通道", "结合 EMA 与 ATR 识别有序突破。", ["Keltner", "EMA20", "ATR10"], "Keltner(20,1.5), EMA20, ATR10", "收盘突破通道上轨且 ATR 未出现异常扩张。", "收盘回到中轨或触发 2×ATR10 移动止损。", "单笔风险 ≤ 0.35%；突破后两根K线不延续则退出。"),
  factor("donchian-breakout", "Donchian 突破", "只参与区间边界被收盘突破的行情。", ["Donchian20", "突破", "成交量"], "Donchian20, Volume/MA20, ATR14", "收盘突破 20 周期上轨且成交量 ≥ MA20 的 1.3 倍。", "跌回突破区间或触发 2×ATR14 移动止损。", "单笔风险 ≤ 0.35%；连续两次假突破暂停。"),
  factor("volume-surge", "成交量放大", "要求成交量确认价格信号，降低假突破。", ["Volume", "MA20", "量价"], "Volume, Volume MA20, EMA20, ATR14", "价格信号成立且成交量 ≥ MA20 的 1.5 倍。", "成交量连续三根低于均量且价格失去方向时退出。", "单笔风险 ≤ 0.3%；不追逐单根异常成交量。"),
  factor("obv-flow", "OBV 资金流", "用量能累积方向辅助趋势判断。", ["OBV", "EMA21", "量价背离"], "OBV, EMA21, RSI14", "价格突破前高且 OBV 同步突破，收盘确认后入场。", "OBV 跌破 EMA21 或出现明确量价背离。", "单笔风险 ≤ 0.3%；背离期间禁止加仓。"),
  factor("vwap-anchor", "VWAP 锚定", "围绕成交量加权价格研究日内偏离。", ["VWAP", "偏离率", "日内"], "VWAP, VWAP偏离率, ATR14", "价格重新站上 VWAP 且成交量恢复至均量附近。", "跌回 VWAP 下方或偏离率达到预设目标。", "单笔风险 ≤ 0.25%；只在流动性充足时运行。"),
  factor("supertrend", "Supertrend", "用 ATR 通道形成清晰的趋势状态。", ["Supertrend", "ATR10", "状态"], "Supertrend(10,3), EMA50, ATR14", "Supertrend 转为多头且价格站在 EMA50 上方。", "Supertrend 反转或价格收盘跌破 EMA50。", "单笔风险 ≤ 0.35%；连续反转 3 次后冷却。"),
  factor("ichimoku", "一目均衡", "以云层和转换线过滤趋势阶段。", ["Ichimoku", "云层", "趋势"], "Ichimoku(9,26,52), ATR14", "价格位于云层上方，转换线上穿基准线并收盘确认。", "价格进入云层或转换线下穿基准线。", "单笔风险 ≤ 0.3%；云层变薄时降低仓位。"),
  factor("pivot-levels", "枢轴点位", "使用日/周枢轴辅助支撑阻力研究。", ["Pivot", "R1/S1", "结构"], "Daily Pivot, R1/S1, RSI14", "价格在枢轴上方形成高低点抬升，并有成交量确认。", "触及下一个阻力分批止盈，跌破枢轴退出。", "单笔风险 ≤ 0.25%；每个点位只允许一次尝试。"),
  factor("support-resistance", "支撑阻力", "把结构性价位写成可验证规则。", ["Swing", "支撑", "阻力"], "Swing High/Low, ATR14, Volume", "支撑附近出现拒绝形态且收盘回到支撑上方。", "触及前高阻力分批退出，失守支撑止损。", "单笔风险 ≤ 0.3%；支撑阻力距离小于 1.5×ATR 时不交易。"),
  factor("rsi-divergence", "RSI 背离", "只研究价格与动能背离后的确认反转。", ["RSI", "背离", "确认"], "RSI14, Swing High/Low, ATR14", "出现底背离后，价格重新站上前一根确认K线高点。", "背离失效或跌破确认低点时退出。", "单笔风险 ≤ 0.2%；必须等待确认，不提前接刀。"),
  factor("regime-switch", "市场状态切换", "在趋势、震荡和高波动状态之间切换模块。", ["ADX", "ATR", "状态机"], "ADX14, ATR14, Bollinger20, EMA50", "状态机确认趋势或震荡后，只启用对应模块。", "状态切换时平仓并等待新状态确认。", "状态不明时仓位为 0%；单日亏损 2% 熔断。"),
  factor("correlation-filter", "相关性过滤", "控制组合中高度相关资产的重复风险。", ["相关性", "组合", "限额"], "20日相关性, ATR14, EMA50", "候选信号成立且与已有仓位相关性低于 0.75。", "相关性升高或组合风险预算超限时减仓。", "组合总风险 ≤ 1%；同类资产最多 2 个仓位。"),
  factor("pairs-spread", "价差均值回归", "只适合有稳定价差关系的配对研究。", ["Z-score", "价差", "对冲"], "Spread Z-score(60), Hedge Ratio, ATR14", "Z-score ≤ -2 且价差回归条件成立，双腿同时确认。", "Z-score 回到 0 附近平仓；关系失稳立即退出。", "总风险 ≤ 0.3%；没有稳定历史关系则禁止使用。"),
  factor("funding-filter", "资金费率过滤", "把永续合约资金费率作为风险过滤而非收益承诺。", ["Funding", "持仓成本", "合约"], "Funding Rate, EMA20, ATR14", "资金费率处于历史中性区间且趋势信号成立。", "费率进入极端区间或趋势失效时退出。", "杠杆默认关闭；单笔风险 ≤ 0.25%。"),
  factor("open-interest", "持仓量确认", "用未平仓量确认或否定价格突破。", ["OI", "价格", "确认"], "Open Interest, Volume, EMA20", "价格突破且 OI 温和增加，成交量不低于均量。", "OI 快速下降或价格回到突破区间时退出。", "单笔风险 ≤ 0.3%；OI 异常跳升时不追单。"),
  factor("sentiment-filter", "情绪过滤", "仅作为风控过滤，不直接生成买卖信号。", ["情绪", "极端值", "过滤"], "Sentiment Index, EMA50, ATR14", "情绪不处于极端区间，且独立价格信号成立。", "情绪进入极端区间时减仓，不逆势赌博。", "情绪数据延迟或缺失时禁止开仓。"),
  factor("liquidity-filter", "流动性过滤", "在深度不足和价差扩大时停止交易。", ["Spread", "深度", "滑点"], "Bid-Ask Spread, Order Book Depth, Volume", "价差、盘口深度和成交量同时达到最低阈值。", "价差扩大或盘口深度跌破阈值时退出/撤单。", "预估滑点超过风险预算时拒绝下单。"),
  factor("time-window", "交易时段过滤", "避开流动性薄弱和重大事件前后时段。", ["时段", "事件", "冷却"], "Session Window, Event Calendar, ATR14", "仅在预设高流动性时段且无事件冷却时开仓。", "进入事件前冷却窗口时减仓或平仓。", "事件日默认不开新仓，除非人工确认。"),
];
const allFactorPresets = [...factorPresets, ...factorExtensions];

const demos: Row[] = [
  ["BTC 趋势守望", "BTC/USDT", 94.8],
  ["ETH 波段均衡", "ETH/USDT", 92.6],
  ["主流币市场中性", "BTC · ETH", 90.4],
  ["SOL 动量捕捉", "SOL/USDT", 88.9],
  ["BNB 区间增强", "BNB/USDT", 86.7],
  ["XRP 流动性观察", "XRP/USDT", 84.3],
  ["多币种低波组合", "BTC · ETH · BNB", 82.8],
  ["DOGE 情绪反转", "DOGE/USDT", 79.6],
  ["LINK 趋势接力", "LINK/USDT", 77.4],
  ["ADA 防守轮动", "ADA/USDT", 75.9],
].map((item, index) => ({
  id: `demo-${index}`,
  name: item[0],
  summary: "趋势、成交量和波动率联合过滤，并设置明确的仓位与退出条件。",
  riskLevel: index === 3 || index === 7 ? "high" : index === 2 || index === 6 || index === 9 ? "low" : "medium",
  symbols: [item[1]],
  version: 1,
  rankingScore: item[2],
  activeFollowers: 0,
  backtests: [],
  demo: true,
}));

function safeJson<T>(raw: string): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function toStrategyDetail(row: Row): StrategyDetailData {
  const backtests = (row.backtests || []) as Row[];
  const currentVersion = Number(row.version || 1);
  const report = backtests.find((item) =>
    item.strategyVersion === currentVersion && item.kind === "backtest",
  );
  return {
    id: String(row.id),
    name: String(row.name || "未命名策略"),
    summary: String(row.summary || "策略规则与风险边界已记录"),
    riskLevel: row.riskLevel === "high" ? "high" : row.riskLevel === "low" ? "low" : "medium",
    symbols: (row.symbols || []) as string[],
    version: currentVersion,
    rankingScore: Number(row.rankingScore || 0),
    activeFollowers: Number(row.activeFollowers || 0),
    publishedAt: row.publishedAt ? String(row.publishedAt) : undefined,
    authorEmail: row.authorEmail ? String(row.authorEmail) : undefined,
    authorName: row.authorNickname ? String(row.authorNickname) : row.authorUsername ? String(row.authorUsername) : undefined,
    authorAvatarUrl: row.authorAvatarUrl ? String(row.authorAvatarUrl) : undefined,
    authorRole: row.authorRole ? String(row.authorRole) : undefined,
    source: "community",
    netReturnPct: report?.netReturnPct == null ? undefined : Number(report.netReturnPct),
    maxDrawdownPct: report?.maxDrawdownPct == null ? undefined : Number(report.maxDrawdownPct),
    winRatePct: report?.winRatePct == null ? undefined : Number(report.winRatePct),
    sampleSize: report?.sampleSize == null ? undefined : Number(report.sampleSize),
  };
}

function backtestFor(row: Row) {
  const version = Number(row.version || 1);
  return ((row.backtests || []) as Row[]).find((item) =>
    item.kind === "backtest" &&
    item.source === "platform_engine" &&
    Number(item.strategyVersion || 1) === version,
  );
}

function riskName(value: unknown) {
  return value === "high" ? "高风险" : value === "low" ? "低风险" : "中风险";
}

function dateName(value: unknown) {
  if (!value) return "时间待同步";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "时间待同步"
    : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function validationName(value: unknown) {
  return value === "STANDARD_VERIFIED" ? "标准验证通过" : "未通过标准验证";
}

type MineScreen = "list" | "create" | "detail" | "backtest";

export default function CommunityStrategyCenter({
  view = "market",
  onOpenStrategy,
  createRequest = 0,
  onWorkspaceScreenChange,
}: {
  view?: "market" | "mine";
  onOpenStrategy?: (strategy: StrategyDetailData) => void;
  createRequest?: number;
  onWorkspaceScreenChange?: (screen: MineScreen) => void;
}) {
  const [rows, setRows] = useState<Row[]>(demos);
  const [mine, setMine] = useState<Row[]>([]);
  const [screen, setScreen] = useState<MineScreen>(createRequest > 0 ? "create" : "list");
  const [selectedStrategyId, setSelectedStrategyId] = useState("");
  const [autoStartBacktest, setAutoStartBacktest] = useState(false);
  const [message, setMessage] = useState("");
  const [studio, setStudio] = useState<Studio>(initial);
  const [preferences, setPreferences] = useState({
    goal: "稳健增长",
    experience: "刚开始研究",
    marketCondition: "趋势与震荡都要过滤",
    frequency: "中频（1小时至4小时）",
  });
  const [busy, setBusy] = useState("");

  async function load() {
    try {
      const response = await fetch("/api/strategy-marketplace", { cache: "no-store" });
      const raw = await response.text();
      const result = safeJson<{ published?: Row[]; mine?: Row[]; error?: string }>(raw);
      if (!response.ok || !result) return;
      setRows(result.published?.length ? result.published : demos);
      setMine(result.mine || []);
    } catch {
      // 未登录时仍可浏览明确标注的版面样例，但不会伪造“我的策略”。
    }
  }

  useEffect(() => {
    let active = true;
    async function initialLoad() {
      try {
        const response = await fetch("/api/strategy-marketplace", { cache: "no-store" });
        const raw = await response.text();
        const result = safeJson<{ published?: Row[]; mine?: Row[] }>(raw);
        if (!active || !response.ok || !result) return;
        setRows(result.published?.length ? result.published : demos);
        setMine(result.mine || []);
      } catch {
        // Public visitors keep the clearly labeled layout examples.
      }
    }
    void initialLoad();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    onWorkspaceScreenChange?.(screen);
  }, [onWorkspaceScreenChange, screen]);

  function openScreen(next: MineScreen, strategyId = "") {
    setSelectedStrategyId(strategyId);
    setScreen(next);
  }

  function applyPreset(preset: FactorPreset) {
    setStudio((current) => ({ ...current, ...preset.defaults }));
    setMessage(`已载入“${preset.title}”研究模板。请结合自己的交易目标修改规则，再启动多 Agent 研发。`);
  }

  const qualityChecks = [
    { label: "交易对与信号周期", ok: Boolean(studio.symbol && studio.period) },
    { label: "入场与退出条件", ok: Boolean(studio.entryRule.trim() && studio.exitRule.trim()) },
    { label: "仓位、止损与最大回撤", ok: Boolean(studio.capital && studio.stopLoss && studio.maxDrawdown) },
    { label: "成熟因子已选择", ok: studio.indicators.split(",").map((item) => item.trim()).filter(Boolean).length >= 2 },
  ];
  const qualityWarnings = [
    Number(studio.stopLoss) >= Number(studio.maxDrawdown) ? "止损不应大于或等于账户最大回撤。" : "",
    Number(studio.capital) > 10 ? "单次资金上限偏高，建议先控制在 5% 以内。" : "",
    !studio.riskRule.trim() ? "建议补充连续亏损暂停和单日熔断条件。" : "",
  ].filter(Boolean);

  async function submit(id: string, shareToMarketplace = false) {
    setBusy(`submit:${id}`);
    try {
      const response = await fetch(`/api/strategy-marketplace/${id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareToMarketplace }),
      });
      const raw = await response.text();
      const result = safeJson<{ message?: string; error?: string }>(raw);
      setMessage(result?.message || result?.error || "提交审核失败");
      if (response.ok) await load();
    } catch {
      setMessage("提交审核失败，请检查网络和登录状态");
    } finally {
      setBusy("");
    }
  }

  if (view === "mine" && screen === "detail" && selectedStrategyId) {
    return <StrategyBacktestDetail
      strategyId={selectedStrategyId}
      onBack={() => openScreen("list")}
      onUpdated={() => void load()}
    />;
  }

  if (view === "mine" && screen === "backtest") {
    const summaries: StrategyBacktestSummary[] = mine.map(row => ({
      id: String(row.id),
      name: String(row.name || "未命名策略"),
      version: Number(row.version || 1),
      symbols: (row.symbols || []) as string[],
      status: String(row.status || "draft"),
      createdAt: row.createdAt ? String(row.createdAt) : undefined,
    }));
    return <StrategyBacktestCenter
      strategies={summaries}
      initialStrategyId={selectedStrategyId}
      autoStart={autoStartBacktest}
      onBack={() => { setAutoStartBacktest(false); openScreen("list"); }}
      onOpenDetail={id => { setAutoStartBacktest(false); openScreen("detail", id); }}
      onUpdated={() => void load()}
    />;
  }

  if (view === "mine" && screen === "create") {
    return <div className="strategy-studio-page">
      <header>
        <button onClick={() => openScreen("list")}>返回我的策略</button>
        <div><small>AI STRATEGY LAB</small><h2>创建策略</h2><p>专业引导、真实历史回测、作者策略模拟测试和平台人工审核。</p></div>
        <div className="strategy-studio-header-actions"><span>平台模型 · 后台任务可恢复</span></div>
      </header>
      {message && <div className="notice">{message}</div>}
      <section className="strategy-research-boundary" aria-label="策略研发与 Agent 对话职责说明">
        <b>策略创建采用独立后台研发任务</b>
        <p>这里不再创建第二套 Agent 对话。切换到其他页面后，后台研发任务会继续运行；返回后会从服务端恢复最近任务及进度。</p>
      </section>
      <div className="studio-layout studio-brief-layout">
        <aside className="strategy-parameter-panel">
          <div className="studio-panel-title"><b>策略指标与参数</b><span>硬边界辅助</span></div>
          <section className="studio-survey">
            <div className="studio-card-heading"><b>策略需求问卷</b><small>帮助 AI 少猜测</small></div>
            <label>主要目标<select value={preferences.goal} onChange={(event) => setPreferences({ ...preferences, goal: event.target.value })}><option>稳健增长</option><option>趋势捕捉</option><option>降低回撤</option><option>震荡套利</option></select></label>
            <label>研究经验<select value={preferences.experience} onChange={(event) => setPreferences({ ...preferences, experience: event.target.value })}><option>刚开始研究</option><option>有回测经验</option><option>熟悉量化交易</option></select></label>
            <label>希望的交易频率<select value={preferences.frequency} onChange={(event) => setPreferences({ ...preferences, frequency: event.target.value })}><option>低频（1日以上）</option><option>中频（1小时至4小时）</option><option>高频（5分钟至15分钟）</option></select></label>
            <label>主要市场状态<select value={preferences.marketCondition} onChange={(event) => setPreferences({ ...preferences, marketCondition: event.target.value })}><option>趋势与震荡都要过滤</option><option>只做趋势行情</option><option>只做震荡行情</option><option>突破后跟随</option></select></label>
          </section>
          <label>策略名称<input value={studio.name} onChange={(event) => setStudio({ ...studio, name: event.target.value })} placeholder="输入策略名称" /></label>
          <section className="studio-usage-choice">
            <div className="studio-card-heading"><b>策略用途</b><small>{studio.publicationMode === "self_use" ? "不进入广场 · 平台不抽成" : "可提交平台审核"}</small></div>
            <label className={studio.publicationMode === "marketplace" ? "selected" : ""}><input aria-label="发布到策略广场" type="radio" name="publicationMode" checked={studio.publicationMode === "marketplace"} onChange={() => setStudio({ ...studio, publicationMode: "marketplace" })} /><span><b>发布到策略广场</b><small>提交平台人工审核，审核通过后其他客户可以跟随。</small></span></label>
            <label className={studio.publicationMode === "self_use" ? "selected" : ""}><input aria-label="自用策略" type="radio" name="publicationMode" checked={studio.publicationMode === "self_use"} onChange={() => setStudio({ ...studio, publicationMode: "self_use" })} /><span><b>自用策略</b><small>仅自己使用，不进入策略广场，平台不抽成。</small></span></label>
          </section>
          <div className="parameter-pair">
            <label>交易对<select value={studio.symbol} onChange={(event) => setStudio({ ...studio, symbol: event.target.value })}>{["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "DOGE/USDT"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>信号周期<select value={studio.period} onChange={(event) => setStudio({ ...studio, period: event.target.value })}>{["5m", "15m", "1h", "4h", "1D"].map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="parameter-pair">
            <label>交易风格<select value={studio.style} onChange={(event) => setStudio({ ...studio, style: event.target.value })}><option>趋势跟随</option><option>区间交易</option><option>突破动量</option><option>市场中性</option></select></label>
            <label>风险等级<select value={studio.risk} onChange={(event) => setStudio({ ...studio, risk: event.target.value as Studio["risk"] })}><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option></select></label>
          </div>
          {[
            ["单次资金上限", "capital", "%", "30"],
            ["止损比例", "stopLoss", "%", "20"],
            ["止盈目标", "takeProfit", "%", "30"],
            ["最大回撤限制", "maxDrawdown", "%", "30"],
          ].map(([label, key, suffix, max]) => <label className="range-setting" key={key}><span>{label}<b>{studio[key as keyof Studio]}{suffix}</b></span><input type="range" min="1" max={max} step="0.5" value={studio[key as keyof Studio]} onChange={(event) => setStudio({ ...studio, [key]: event.target.value })} /></label>)}
          <label className="studio-rule-field">入场规则<textarea value={studio.entryRule} onChange={(event) => setStudio({ ...studio, entryRule: event.target.value })} placeholder="例：EMA20 上穿 EMA60 且 ADX14 ≥ 22，收盘确认后入场" /></label>
          <label className="studio-rule-field">退出规则<textarea value={studio.exitRule} onChange={(event) => setStudio({ ...studio, exitRule: event.target.value })} placeholder="例：跌破 EMA60 或触发 2×ATR 移动止损" /></label>
          <label className="studio-rule-field">风控与暂停条件<textarea value={studio.riskRule} onChange={(event) => setStudio({ ...studio, riskRule: event.target.value })} placeholder="例：连续3次亏损暂停，单日亏损2%停止开仓" /></label>
          <details className="studio-factor-library">
            <summary><span><b>成熟因子模板</b><small>按需展开 · {allFactorPresets.length} 个可审计研究模板</small></span><em>展开选择</em></summary>
            <div className="studio-factor-grid">{allFactorPresets.map((preset) => <button type="button" className="studio-factor-card" key={preset.id} onClick={() => applyPreset(preset)}><strong>{preset.title}</strong><span>{preset.summary}</span><small>{preset.tags.join(" · ")}</small></button>)}</div>
          </details>
          <section className="studio-quality-card">
            <div className="studio-card-heading"><b>回测前检查</b><small>{qualityChecks.filter((item) => item.ok).length}/{qualityChecks.length} 已完成</small></div>
            <div className="studio-quality-list">{qualityChecks.map((item) => <span className={item.ok ? "ok" : "todo"} key={item.label}>{item.ok ? "✓" : "!"} {item.label}</span>)}</div>
            {qualityWarnings.map((warning) => <p className="studio-warning" key={warning}>提示：{warning}</p>)}
          </section>
          <label className="studio-indicator-input">当前引擎指标<input value={studio.indicators} onChange={(event) => setStudio({ ...studio, indicators: event.target.value })} placeholder="EMA20, EMA60, RSI14, ATR14" /><small>用逗号分隔。优先选择趋势、波动率、成交量三类因子。</small></label>
        </aside>
      </div>
      <MultiAgentResearch brief={{
        name: studio.name || "多 Agent 策略研究",
        publicationMode: studio.publicationMode,
        symbol: studio.symbol.replace("/", "").toUpperCase(),
        timeframe: studio.period.toLowerCase(),
        style: studio.style,
        riskLevel: studio.risk,
        goal: preferences.goal,
        experience: preferences.experience,
        marketCondition: preferences.marketCondition,
        frequency: preferences.frequency,
        indicators: studio.indicators,
        positionSizePct: Number(studio.capital),
        stopLossPct: Number(studio.stopLoss),
        takeProfitPct: Number(studio.takeProfit),
        maxDrawdownPct: Number(studio.maxDrawdown),
        entryRule: studio.entryRule,
        exitRule: studio.exitRule,
        riskRule: studio.riskRule,
      }} />
    </div>;
  }

  if (view === "mine") {
    return <div className="community-center">
      {message && <div className="notice">{message}</div>}
      <nav className="strategy-workspace-tabs" aria-label="策略工作区">
        <button type="button" className="active" aria-current="page"><b>策略列表</b><small>{mine.length} 个策略 · 版本、审核与分享</small></button>
        <button type="button" onClick={() => { setAutoStartBacktest(false); openScreen("backtest"); }}><b>回测与模拟</b><small>动态进度、资金曲线与模拟说明</small></button>
      </nav>
      <div className="my-strategy-card-grid">{mine.map((row) => {
        const hasBacktest = Boolean(backtestFor(row));
        const id = String(row.id);
        const selfUse = row.publicationMode === "self_use";
        const submitted = ["submitted", "approved", "published"].includes(String(row.status));
        return <article key={id}>
          <header><span>{selfUse ? "自用策略" : String(row.status) === "published" ? "已上架" : String(row.status) === "submitted" ? "审核中" : "我的策略"}</span><em>V{String(row.version)}</em></header>
          <h3>{String(row.name)}</h3><p>{((row.symbols || []) as string[]).join(" · ")} · {riskName(row.riskLevel)}{selfUse ? " · 平台不抽成" : ""}</p>
          <dl className="my-strategy-card-meta"><div><dt>创建时间</dt><dd>{dateName(row.createdAt)}</dd></div><div><dt>验证状态</dt><dd className={row.validationLabel === "STANDARD_VERIFIED" ? "verified" : "unverified"}>{validationName(row.validationLabel)}</dd></div></dl>
          <div className="my-strategy-card-status"><span className={hasBacktest ? "complete" : ""}>回测报告 {hasBacktest ? "已生成" : "待运行"}</span><span>模拟运行 未启动</span></div>
          <div className="strategy-backtest-actions"><button type="button" onClick={() => openScreen("detail", id)}>查看策略</button>{!submitted && <button type="button" disabled={Boolean(busy)} onClick={() => { setAutoStartBacktest(true); openScreen("backtest", id); }}>快速回测</button>}</div>
          <button type="button" className="strategy-share-action" disabled={submitted || Boolean(busy)} onClick={() => void submit(id, selfUse)}>{String(row.status) === "published" ? "已分享到策略广场" : String(row.status) === "submitted" ? "等待平台人工审核" : selfUse ? "分享到策略广场" : "提交到策略广场"}</button>
        </article>;
      })}</div>
      {!mine.length && <div className="notice">当前账号还没有真实保存的策略。点击“创建策略”开始，不会再展示虚构草稿。</div>}
    </div>;
  }

  const ordered = [...rows].sort((a, b) => Number(b.rankingScore || 0) - Number(a.rankingScore || 0));
  return <div className="community-center">
    <section className="community-ranking-section">
      <div className="market-section-title"><div><small>COMMUNITY STRATEGIES</small><h2>社区策略综合排名</h2></div><span>收益 · 回撤 · 稳定性 · 有效跟随</span></div>
      <div className="community-grid five-columns">{ordered.map((row, index) => {
        const report = backtestFor(row);
        const hasReport = Boolean(report);
        return <article key={String(row.id)}>
          <header><span>{riskName(row.riskLevel)}</span><em>综合 #{index + 1}</em></header><h3>{String(row.name)}</h3><p>{String(row.summary)}</p>
          <div className="strategy-symbols">{((row.symbols || []) as string[]).map((symbol) => <i key={symbol}>{symbol}</i>)}</div>
          <dl className="strategy-real-metrics">
            <div><dt>历史收益</dt><dd className={Number(report?.netReturnPct || 0) >= 0 ? "green" : "down"}>{hasReport ? `${Number(report?.netReturnPct || 0) > 0 ? "+" : ""}${Number(report?.netReturnPct).toFixed(1)}%` : "暂无报告"}</dd></div>
            <div><dt>最大回撤</dt><dd>{hasReport ? `${Number(report?.maxDrawdownPct || 0).toFixed(1)}%` : "—"}</dd></div>
            <div><dt>历史胜率</dt><dd>{hasReport ? `${Number(report?.winRatePct || 0).toFixed(1)}%` : "—"}</dd></div>
            <div><dt>交易样本</dt><dd>{hasReport ? `${String(report?.sampleSize || 0)} 笔` : "未运行"}</dd></div>
            <div><dt>策略版本</dt><dd>V{String(row.version || 1)}</dd></div><div><dt>有效跟随</dt><dd>{String(row.activeFollowers || 0)} 人</dd></div>
          </dl>
          <div className="strategy-score"><span className="score-main"><small>综合评分</small><b>{String(row.rankingScore || "待评估")}</b></span><div><span>V{String(row.version || 1)}</span><span>{row.demo ? "版面样例" : "回测报告"}</span></div></div>
          <button className="primary strategy-follow-cta" aria-label={`跟随${String(row.name)}`} onClick={() => onOpenStrategy?.(toStrategyDetail(row))}>跟随</button>
        </article>;
      })}</div>
    </section>
  </div>;
}
