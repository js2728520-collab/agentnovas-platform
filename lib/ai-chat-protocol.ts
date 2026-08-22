export type AssistantContext = {
  generatedAt: string;
  market: null | {
    symbol: string;
    price: number;
    change24hPct: number;
    high24h: number;
    low24h: number;
    timeframe?: "1h";
    ema20?: number;
    ema60?: number;
    rsi14?: number;
    atr14?: number;
    support?: number;
    resistance?: number;
    candleCount?: number;
    latestCandleAt?: string;
    source: string;
  };
  portfolio: {
    openPositions: number;
    positionSymbols: string[];
    followedStrategies: string[];
  };
};

export type AssistantIntent =
  | "market_analysis"
  | "portfolio_risk"
  | "strategy_research"
  | "backtest_help"
  | "general";

export type SessionWorkingMemory = {
  knownFields: {
    symbol?: string;
    timeframe?: string;
    maxDrawdownPct?: number;
    positionPct?: number;
    stopLossPct?: number;
    takeProfitPct?: number;
  };
  recentUserFacts: string[];
  instruction: string;
};

export type GuidedAssistantResult = {
  text: string;
  mode: "guided_rules";
  suggestedAction?: "strategy";
};

export function deriveConversationTitle(message: string) {
  return message.trim().replace(/\s+/g, " ").slice(0, 28) || "新对话";
}

export function serializeSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function splitStreamingText(value: string, size = 18) {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}

export function classifyAssistantIntent(message: string): AssistantIntent {
  if (/回测|收益曲线|夏普|胜率|盈亏比|过拟合/.test(message)) return "backtest_help";
  if (/持仓|仓位|账户|组合|敞口|回撤|亏损/.test(message)) return "portfolio_risk";
  if (/生成|创建|编写|策略|入场|出场|止损|止盈/.test(message)) return "strategy_research";
  if (/行情|走势|趋势|价格|支撑|阻力|技术面|RSI|EMA|ATR|BTC|ETH|SOL/i.test(message)) return "market_analysis";
  return "general";
}

function readPercentage(text: string, label: RegExp) {
  const match = text.match(new RegExp(`${label.source}(?:不超过|控制在|设为|为|是|[:：])?\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "i"));
  return match ? Number(match[1]) : undefined;
}

export function buildSessionWorkingMemory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  latestMessage: string,
): SessionWorkingMemory {
  const userFacts = history.filter((message) => message.role === "user").map((message) => message.content);
  if (userFacts.at(-1) !== latestMessage) userFacts.push(latestMessage);
  const recentUserFacts = userFacts.slice(-6);
  const text = recentUserFacts.join("\n");
  const symbolMatch = text.toUpperCase().match(/\b(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|LINK|TRX|DOT|LTC|BCH|TON|SUI|APT|NEAR|ARB|OP|UNI)(?:\s*[/_-]?\s*USDT)?\b/);
  const timeframeMatch = text.match(/\b(5m|15m|30m|1h|4h|1d)\b|(?:5|15|30)\s*分钟|(?:1|4)\s*小时|(?:1\s*)?日线/i);
  const timeframeText = timeframeMatch?.[0]?.toLowerCase();
  const timeframe = timeframeText?.includes("分钟")
    ? `${timeframeText.match(/\d+/)?.[0]}m`
    : timeframeText?.includes("小时")
      ? `${timeframeText.match(/\d+/)?.[0]}h`
      : timeframeText?.includes("日线")
        ? "1d"
        : timeframeText;
  const knownFields: SessionWorkingMemory["knownFields"] = {
    symbol: symbolMatch ? `${symbolMatch[1]}USDT` : undefined,
    timeframe,
    maxDrawdownPct: readPercentage(text, /最大回撤/),
    positionPct: readPercentage(text, /(?:单次)?仓位/),
    stopLossPct: readPercentage(text, /止损/),
    takeProfitPct: readPercentage(text, /止盈/),
  };
  const knownNames = Object.entries(knownFields).filter(([, value]) => value !== undefined).map(([name]) => name);
  return {
    knownFields,
    recentUserFacts,
    instruction: knownNames.length
      ? `已知字段：${knownNames.join("、")}。不要重复询问已知字段；最多只追问 2 个会实质改变结论的缺失条件。`
      : "当前没有可确认的策略参数；最多只追问 2 个会实质改变结论的条件。",
  };
}

function valueOrUnknown(value: number | undefined, suffix = "") {
  return Number.isFinite(value) ? `${value}${suffix}` : "不可用";
}

export function guidedAssistantReply(
  message: string,
  context: AssistantContext,
  memory?: SessionWorkingMemory,
): GuidedAssistantResult {
  const intent = classifyAssistantIntent(message);
  if (intent === "strategy_research") {
    const known = memory?.knownFields || buildSessionWorkingMemory([], message).knownFields;
    const knownSummary = [known.symbol, known.timeframe].filter(Boolean).join(" / ");
    return {
      text: `结论：可以把${knownSummary ? ` ${knownSummary} 的` : "你的"}想法整理成平台可校验的 JSON 策略草稿。\n\n关键证据与失效条件：策略必须明确入场、退出、仓位、止损止盈和最大回撤；缺少这些边界时，回测结果不具备决策意义。\n\n下一步：补充尚未说明的关键边界，然后进入策略广场生成、保存并回测。草稿不会自动下单。`,
      mode: "guided_rules",
      suggestedAction: "strategy",
    };
  }

  if (intent === "portfolio_risk") {
    const symbols = context.portfolio.positionSymbols.length
      ? `，涉及 ${context.portfolio.positionSymbols.join("、")}`
      : "";
    const following = context.portfolio.followedStrategies.length
      ? `；当前跟随：${context.portfolio.followedStrategies.join("、")}`
      : "";
    return {
      text: `结论：账户摘要中有 ${context.portfolio.openPositions} 个未平仓记录${symbols}${following}，应先检查集中度和最大回撤边界。\n\n关键证据与失效条件：当前摘要不包含完整成交成本和账户净值，无法据此给出精确风险比例；若仓位或余额已变化，本结论失效。\n\n下一步：核对单次仓位、单日亏损和最大回撤是否在硬边界内。规则引导模式不会替你调整仓位或下单。`,
      mode: "guided_rules",
    };
  }

  if (intent === "backtest_help") {
    return {
      text: "结论：仅凭一句描述无法判断策略回测是否有效，需要同时检查收益、最大回撤、交易样本、成本和样本外稳定性。\n\n关键证据与失效条件：高收益若来自少量交易、未计手续费/滑点或单一行情阶段，结论很容易失效；回测也不等于未来表现。\n\n下一步：在“我的策略”打开已保存策略，运行实盘对齐预设，并提供净收益、最大回撤、胜率、盈亏因子、样本数和警告，我再逐项解释。",
      mode: "guided_rules",
    };
  }

  if (context.market) {
    const direction = context.market.change24hPct >= 0 ? "+" : "";
    const technicalEvidence = context.market.ema20 === undefined
      ? "技术指标不可用"
      : `EMA20 ${valueOrUnknown(context.market.ema20)}、EMA60 ${valueOrUnknown(context.market.ema60)}、RSI14 ${valueOrUnknown(context.market.rsi14)}、ATR14 ${valueOrUnknown(context.market.atr14)}`;
    const structure = context.market.ema20 !== undefined && context.market.ema60 !== undefined
      ? context.market.ema20 >= context.market.ema60 ? "短周期结构偏强" : "短周期结构偏弱"
      : "方向证据不足";
    return {
      text: `结论：${context.market.symbol} ${structure}，但需要价格突破并站稳关键区间后再确认。\n\n关键证据：现价 ${context.market.price}，24 小时变化 ${direction}${context.market.change24hPct.toFixed(2)}%；${technicalEvidence}；参考支撑 ${valueOrUnknown(context.market.support ?? context.market.low24h)}，阻力 ${valueOrUnknown(context.market.resistance ?? context.market.high24h)}。\n\n失效条件：跌破参考支撑，或行情时间 ${context.market.latestCandleAt || context.generatedAt} 之后结构已明显变化。数据源：${context.market.source}。\n\n下一步：先确定观察周期、入场触发和最大可承受回撤，再生成可回测策略；不会自动下单。`,
      mode: "guided_rules",
    };
  }

  return {
    text: "结论：当前缺少足够的可验证行情或账户证据，不能给出具体交易判断。\n\n关键证据与失效条件：平台规则引导模式不会编造实时价格、收益或交易结论。\n\n下一步：请说明具体交易对、周期，以及你要分析行情、持仓风险、策略还是回测。",
    mode: "guided_rules",
  };
}
