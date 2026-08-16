export type AssistantContext = {
  generatedAt: string;
  market: null | {
    symbol: string;
    price: number;
    change24hPct: number;
    high24h: number;
    low24h: number;
    source: string;
  };
  portfolio: {
    openPositions: number;
    positionSymbols: string[];
    followedStrategies: string[];
  };
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

export function guidedAssistantReply(message: string, context: AssistantContext): GuidedAssistantResult {
  if (/生成|创建|编写|策略/.test(message)) {
    return {
      text: "我可以把你的想法整理成平台可校验的 JSON 策略规则。请说明交易对、周期、入场、退出、仓位、止损止盈和最大回撤；生成结果只会成为研究草稿，不会自动下单。",
      mode: "guided_rules",
      suggestedAction: "strategy",
    };
  }

  if (/持仓|仓位|风险|回撤|亏损/.test(message)) {
    const symbols = context.portfolio.positionSymbols.length
      ? `，涉及 ${context.portfolio.positionSymbols.join("、")}`
      : "";
    const following = context.portfolio.followedStrategies.length
      ? `；当前跟随：${context.portfolio.followedStrategies.join("、")}`
      : "";
    return {
      text: `账户摘要中有 ${context.portfolio.openPositions} 个未平仓记录${symbols}${following}。请先核对单次仓位、单日亏损和最大回撤是否在你的硬边界内；规则引导模式不会替你调整仓位或下单。`,
      mode: "guided_rules",
    };
  }

  if (context.market) {
    const direction = context.market.change24hPct >= 0 ? "+" : "";
    return {
      text: `${context.market.symbol} 公共行情参考价 ${context.market.price}，24 小时变化 ${direction}${context.market.change24hPct.toFixed(2)}%，区间 ${context.market.low24h}–${context.market.high24h}。来源：${context.market.source}，时间：${context.generatedAt}。当前没有模型服务，不能进一步声称趋势结论。`,
      mode: "guided_rules",
    };
  }

  return {
    text: "当前使用平台规则引导模式。你可以询问已连接账户的持仓风险，或说明一个具体交易对和周期；没有可验证行情或模型依据时，我不会编造实时价格、收益或交易结论。",
    mode: "guided_rules",
  };
}
