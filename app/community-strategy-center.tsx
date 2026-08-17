"use client";

import { useEffect, useState } from "react";
import type { StrategyDsl } from "@/lib/strategy-dsl";
import { consumeAiEventStream } from "./ai-sse";
import { CustomLlmButton } from "./llm-config";
import type { StrategyDetailData } from "./strategy-detail";

type Row = Record<string, unknown>;
type ChatMessage = { role: "user" | "assistant"; text: string };
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
type BacktestResult = {
  status?: string;
  sampleSize?: number;
  netReturnPct?: number;
  maxDrawdownPct?: number;
  winRatePct?: number;
  feesUsdt?: number;
  slippageUsdt?: number;
  evidenceRef?: string;
  provider?: string;
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

const quickPrompts = [
  "我是新手，请用稳健的 BTC 趋势模板引导我",
  "我想做震荡行情，帮我确认 RSI 和布林带参数",
  "请检查我的止损、止盈和最大回撤是否互相矛盾",
];

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

function apiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || fallback);
  }
  return fallback;
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

export default function CommunityStrategyCenter({
  view = "market",
  onOpenStrategy,
  createRequest = 0,
}: {
  view?: "market" | "mine";
  onOpenStrategy?: (strategy: StrategyDetailData) => void;
  createRequest?: number;
}) {
  const [rows, setRows] = useState<Row[]>(demos);
  const [mine, setMine] = useState<Row[]>([]);
  const [screen, setScreen] = useState<"list" | "create">(createRequest > 0 ? "create" : "list");
  const [message, setMessage] = useState("");
  const [studio, setStudio] = useState<Studio>(initial);
  const [preferences, setPreferences] = useState({
    goal: "稳健增长",
    experience: "刚开始研究",
    marketCondition: "趋势与震荡都要过滤",
    frequency: "中频（1小时至4小时）",
  });
  const [prompt, setPrompt] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([{
    role: "assistant",
    text: "我会先了解你的目标、经验和市场偏好，再把想法拆成可回测的入场、退出、仓位与熔断条件。你可以先点击一个成熟模板，也可以直接告诉我你的交易想法。",
  }]);
  const [strategyConversationId, setStrategyConversationId] = useState("");
  const [chatStreamText, setChatStreamText] = useState("");
  const [generated, setGenerated] = useState(false);
  const [generatedSpecification, setGeneratedSpecification] = useState<StrategyDsl | null>(null);
  const [generatedExplanation, setGeneratedExplanation] = useState("");
  const [generationId, setGenerationId] = useState("");
  const [generatedInputSignature, setGeneratedInputSignature] = useState("");
  const [busy, setBusy] = useState("");
  const [draftId, setDraftId] = useState("");
  const [draftVersion, setDraftVersion] = useState(0);
  const [savedSignature, setSavedSignature] = useState("");
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const studioInputSignature = JSON.stringify({ studio, preferences });
  const hasGeneratedStrategy = Boolean(
    generated && generatedSpecification && generatedInputSignature === studioInputSignature,
  );

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

  function payload() {
    return {
      name: studio.name.trim(),
      publicationMode: studio.publicationMode,
      summary: `${studio.style} · ${studio.period} · 单次资金上限 ${studio.capital}% · 止损 ${studio.stopLoss}% · 止盈 ${studio.takeProfit}%`,
      symbols: [studio.symbol],
      riskLevel: studio.risk,
      conversationId: strategyConversationId,
      generationId,
      specification: generatedSpecification,
    };
  }

  function applyPreset(preset: FactorPreset) {
    setStudio((current) => ({ ...current, ...preset.defaults }));
    setGenerated(false);
    setGeneratedSpecification(null);
    setGeneratedExplanation("");
    setGenerationId("");
    setGeneratedInputSignature("");
    setBacktest(null);
    setMessage(`已载入“${preset.title}”研究模板。请结合自己的交易目标修改规则，再向 AI 研究员确认。`);
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

  async function ensureDraft() {
    if (!studio.name.trim()) throw new Error("请先填写策略名称");
    const body = payload();
    const signature = JSON.stringify(body);
    if (draftId && signature === savedSignature) return { id: draftId, version: draftVersion };
    const endpoint = draftId ? `/api/strategy-marketplace/${draftId}` : "/api/strategy-marketplace";
    const response = await fetch(endpoint, {
      method: draftId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    const result = safeJson<{ id?: string; version?: number; error?: unknown }>(raw);
    if (!response.ok || !result?.id) throw new Error(apiError(result, "策略草稿保存失败"));
    const version = Number(result.version || 1);
    setDraftId(result.id);
    setDraftVersion(version);
    setSavedSignature(signature);
    setBacktest(null);
    return { id: result.id, version };
  }

  async function ensureStrategyConversation() {
    if (strategyConversationId) return strategyConversationId;
    const response = await fetch("/api/ai/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "strategy", title: studio.name.trim() ? `策略研究：${studio.name.trim()}` : "AI 策略研究" }),
    });
    const payload = await response.json().catch(() => null) as { conversation?: { id?: string } } | null;
    const id = String(payload?.conversation?.id || "");
    if (!response.ok || !id) throw new Error(apiError(payload, "策略对话创建失败"));
    setStrategyConversationId(id);
    return id;
  }

  async function ask() {
    const text = prompt.trim();
    if (!text || busy) return;
    setChat((items) => [...items, { role: "user", text }]);
    setPrompt("");
    setBusy("chat");
    setChatStreamText("");
    try {
      const conversationId = await ensureStrategyConversation();
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      let streamed = "";
      await consumeAiEventStream(response, (event, data) => {
        if (event === "delta" && typeof data.text === "string") {
          streamed += data.text;
          setChatStreamText(streamed);
        } else if (event === "done") {
          const saved = data.message as { content?: string; generationMode?: string } | undefined;
          const content = saved?.content || streamed;
          if (content) setChat((items) => [...items, {
            role: "assistant",
            text: `${content}${saved?.generationMode === "guided_rules" ? "（当前为平台规则引导模式）" : ""}`,
          }]);
          setChatStreamText("");
        } else if (event === "error") {
          throw new Error(String(data.message || "策略研究服务暂不可用"));
        }
      });
    } catch (error) {
      setChatStreamText("");
      setMessage(error instanceof Error ? error.message : "策略研究服务暂不可用");
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    if (busy) return;
    if (!chat.some((item) => item.role === "user")) {
      setMessage("请先向策略研究 Agent 说明你的策略想法");
      return;
    }
    if (qualityChecks.filter((item) => !item.ok).length > 0) {
      setMessage("还有关键规则没有补齐。请先处理回测前检查中的待完善项，避免生成无法验证的策略。");
      return;
    }
    if (qualityWarnings.length) {
      setMessage(`生成前提示：${qualityWarnings.join(" ")}`);
    }
    setBusy("generate");
    try {
      const conversationId = await ensureStrategyConversation();
      const response = await fetch("/api/strategy-studio/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          brief: {
            name: studio.name,
            symbol: studio.symbol,
            period: studio.period,
            style: studio.style,
            risk: studio.risk,
            capital: studio.capital,
            stopLoss: studio.stopLoss,
            takeProfit: studio.takeProfit,
            maxDrawdown: studio.maxDrawdown,
            indicators: studio.indicators,
            entryRule: studio.entryRule,
            exitRule: studio.exitRule,
            riskRule: studio.riskRule,
            ...preferences,
          },
        }),
      });
      const payload = await response.json().catch(() => null) as {
        specification?: StrategyDsl;
        explanation?: string;
        mode?: "ai_provider" | "guided_rules";
        generationId?: string;
      } | null;
      if (!response.ok || !payload?.specification || !payload.mode || !payload.generationId) {
        throw new Error(apiError(payload, "策略生成服务没有返回有效规则"));
      }
      setGeneratedSpecification(payload.specification);
      setGeneratedExplanation(payload.explanation || "候选 DSL 已通过平台校验");
      setGenerationId(payload.generationId);
      setGeneratedInputSignature(studioInputSignature);
      setGenerated(true);
      setBacktest(null);
      setMessage(payload.mode === "guided_rules"
        ? "当前未配置模型，已使用平台保守模板生成并通过 DSL 校验。"
        : "AI 候选规则已通过 DSL 校验；保存草稿后可运行真实历史回测。");
    } catch (error) {
      setGenerated(false);
      setGeneratedSpecification(null);
      setGenerationId("");
      setGeneratedInputSignature("");
      setMessage(error instanceof Error ? error.message : "策略生成失败");
    } finally {
      setBusy("");
    }
  }

  async function runBacktest(id: string) {
    setBusy(`backtest:${id}`);
    setMessage("正在获取历史K线并计算手续费、滑点和回撤…");
    try {
      const response = await fetch(`/api/strategy-marketplace/${id}/backtest`, {
        method: "POST",
      });
      const raw = await response.text();
      const result = safeJson<{ message?: string; error?: string; result?: BacktestResult }>(raw);
      if (!response.ok || !result) throw new Error(result?.error || "回测服务没有返回有效结果");
      setMessage(result.message || "回测完成");
      setBacktest(result.result || null);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回测失败");
    } finally {
      setBusy("");
    }
  }

  async function runDraftBacktest() {
    if (!hasGeneratedStrategy) {
      setMessage("请先生成结构化策略规则");
      return;
    }
    try {
      const draft = await ensureDraft();
      await runBacktest(draft.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法保存策略草稿");
    }
  }

  async function save() {
    if (!hasGeneratedStrategy) {
      setMessage("请先完成对话并生成结构化策略规则");
      return;
    }
    setBusy("save");
    try {
      await ensureDraft();
      await load();
      setScreen("list");
      setMessage("策略已真实保存到“我的策略”");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "策略保存失败");
    } finally {
      setBusy("");
    }
  }

  async function submit(id: string) {
    setBusy(`submit:${id}`);
    try {
      const response = await fetch(`/api/strategy-marketplace/${id}/submit`, { method: "POST" });
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

  if (view === "mine" && screen === "create") {
    return <div className="strategy-studio-page">
      <header>
        <button onClick={() => setScreen("list")}>返回我的策略</button>
        <div><small>AI STRATEGY LAB</small><h2>创建策略</h2><p>专业引导、真实历史回测、作者策略模拟测试和平台人工审核。</p></div>
        <div className="strategy-studio-header-actions"><CustomLlmButton /><span>{draftId ? `草稿 V${draftVersion}` : "尚未保存"}</span></div>
      </header>
      {message && <div className="notice">{message}</div>}
      <div className="studio-layout">
        <section className="strategy-chat-panel">
          <div className="studio-panel-title"><b>AI 策略研究员</b><span><i />{busy === "chat" ? "思考中" : "在线"}</span></div>
          <div className="studio-research-brief">
            <strong>先问清楚，再生成规则</strong>
            <p>研究员会把你的想法拆成可验证的入场、退出、仓位和熔断条件；不承诺收益，也不会用虚构数据替代回测。</p>
            <div className="studio-quick-prompts">{quickPrompts.map((item) => <button type="button" key={item} onClick={() => setPrompt(item)}>{item}</button>)}</div>
          </div>
          <div className="studio-chat-log" aria-live="polite">{chat.map((item, index) => <div className={item.role === "assistant" ? "ai" : "user"} key={`${item.role}-${index}`}><b>{item.role === "assistant" ? "策略研究 Agent" : "我"}</b><p>{item.text}</p></div>)}{chatStreamText && <div className="ai streaming"><b>策略研究 Agent</b><p>{chatStreamText}<span aria-hidden="true">▋</span></p></div>}</div>
          <div className="studio-prompt"><textarea aria-label="策略研究问题" maxLength={2_000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：BTC 15分钟趋势策略，震荡行情不交易，最大回撤不超过12%……" /><button disabled={busy === "chat" || !prompt.trim()} onClick={() => void ask()}>{busy === "chat" ? "生成中…" : "发送"}</button></div>
        </section>
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
          <section className="studio-factor-library">
            <div className="studio-card-heading"><b>成熟因子模板</b><small>点击载入，可继续修改</small></div>
            <div className="studio-factor-grid">{allFactorPresets.map((preset) => <button type="button" className="studio-factor-card" key={preset.id} onClick={() => applyPreset(preset)}><strong>{preset.title}</strong><span>{preset.summary}</span><small>{preset.tags.join(" · ")}</small></button>)}</div>
          </section>
          <section className="studio-quality-card">
            <div className="studio-card-heading"><b>回测前检查</b><small>{qualityChecks.filter((item) => item.ok).length}/{qualityChecks.length} 已完成</small></div>
            <div className="studio-quality-list">{qualityChecks.map((item) => <span className={item.ok ? "ok" : "todo"} key={item.label}>{item.ok ? "✓" : "!"} {item.label}</span>)}</div>
            {qualityWarnings.map((warning) => <p className="studio-warning" key={warning}>提示：{warning}</p>)}
          </section>
          <label className="studio-indicator-input">当前引擎指标<input value={studio.indicators} onChange={(event) => setStudio({ ...studio, indicators: event.target.value })} placeholder="EMA20, EMA60, RSI14, ATR14" /><small>用逗号分隔。优先选择趋势、波动率、成交量三类因子。</small></label>
        </aside>
      </div>
      <section className="strategy-output">
        <div><small>STRUCTURED STRATEGY</small><h3>{hasGeneratedStrategy ? generatedSpecification?.name || studio.name || "未命名候选策略" : "等待生成策略"}</h3><p>{hasGeneratedStrategy ? generatedExplanation : "完成对话和参数设置后，由 AI 提案并通过平台 DSL 校验器生成候选规则。"}</p>{hasGeneratedStrategy && generatedSpecification && <details className="strategy-dsl-preview"><summary>查看已校验 JSON DSL</summary><pre>{JSON.stringify(generatedSpecification, null, 2)}</pre></details>}</div>
        {backtest && <div className="backtest-result"><span>真实回测收益<b>{backtest.netReturnPct == null ? "—" : `${backtest.netReturnPct > 0 ? "+" : ""}${backtest.netReturnPct.toFixed(2)}%`}</b></span><span>最大回撤<b>{backtest.maxDrawdownPct == null ? "—" : `${backtest.maxDrawdownPct.toFixed(2)}%`}</b></span><span>胜率<b>{backtest.winRatePct == null ? "—" : `${backtest.winRatePct.toFixed(1)}%`}</b></span><span>样本数<b>{backtest.sampleSize ?? 0} 笔</b></span></div>}
        {backtest && <p className="strategy-data-note">来源：{backtest.provider || "平台行情引擎"}；手续费 {backtest.feesUsdt?.toFixed(2) || "0.00"} USDT；滑点 {backtest.slippageUsdt?.toFixed(2) || "0.00"} USDT；证据哈希已留存。</p>}
        <div className="studio-actions"><button disabled={Boolean(busy)} onClick={() => void generate()}>{busy === "generate" ? "校验生成中…" : "生成候选规则"}</button><button disabled={!hasGeneratedStrategy || Boolean(busy)} onClick={() => void runDraftBacktest()}>{busy.startsWith("backtest") ? "回测中…" : "真实历史回测"}</button><button className="primary" disabled={!hasGeneratedStrategy || Boolean(busy)} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存到我的策略"}</button></div>
      </section>
    </div>;
  }

  if (view === "mine") {
    return <div className="community-center">
      {message && <div className="notice">{message}</div>}
      <section className="my-strategy-modules">
        <article><i>01</i><div><small>STRATEGY MANAGEMENT</small><h3>策略管理</h3><p>查看草稿、回测报告、审核状态和版本。</p></div><span>{mine.length} 个策略</span></article>
        <article><i>02</i><div><small>BACKTEST CENTER</small><h3>回测与模拟测试</h3><p>历史回测与作者策略模拟测试均为研究工具，不会触发真实订单。</p></div><span>自由测试</span></article>
      </section>
      <div className="my-strategy-card-grid">{mine.map((row) => {
        const hasBacktest = Boolean(backtestFor(row));
        const id = String(row.id);
        const selfUse = row.publicationMode === "self_use";
        const submitted = ["submitted", "approved", "published"].includes(String(row.status));
        return <article key={id}>
          <header><span>{selfUse ? "自用策略" : String(row.status) === "published" ? "已上架" : String(row.status) === "submitted" ? "审核中" : "我的策略"}</span><em>V{String(row.version)}</em></header>
          <h3>{String(row.name)}</h3><p>{((row.symbols || []) as string[]).join(" · ")} · {riskName(row.riskLevel)}{selfUse ? " · 平台不抽成" : ""}</p>
          <div><span className={hasBacktest ? "complete" : ""}>回测报告 {hasBacktest ? "已生成" : "可选"}</span><span>模拟测试 可选</span></div>
          {!submitted && <div className="strategy-backtest-actions"><button disabled={Boolean(busy)} onClick={() => void runBacktest(id)}>{busy === `backtest:${id}` ? "回测中…" : "运行历史回测"}</button></div>}
          {selfUse ? <div className="strategy-self-use-note">自用策略 · 不进入策略广场 · 平台不抽成</div> : <button className="primary" disabled={submitted || Boolean(busy)} onClick={() => void submit(id)}>{String(row.status) === "published" ? "已上架策略广场" : String(row.status) === "submitted" ? "等待平台人工审核" : "提交到策略广场"}</button>}
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
