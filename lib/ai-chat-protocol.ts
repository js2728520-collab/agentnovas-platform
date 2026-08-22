import type { PlatformFactSnapshot } from "../packages/contracts/src/platform-facts.ts";

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
  /**
   * 平台事实快照（价格、费率、权限边界、策略卡参数、七智能体流程）。
   * 只在需要时装载——它有 2KB 左右，每次都塞进提示词是浪费。
   * 数字全部来自 packages/contracts，助手不得自行编造。
   */
  platform?: PlatformFactSnapshot;
  /** 该客户最近的决策轮摘要，用于回答「这一轮为什么没开仓」。 */
  decisions?: Array<{
    decisionRoundId: string;
    strategyName: string;
    symbol: string;
    action: string;
    riskApproved: boolean;
    rejectionReasons: string[];
    decidedAt: string | null;
    stages: Array<{ role: string; conclusion: string; explanation?: string }>;
  }>;
};

export type AssistantIntent =
  | "platform_info"
  | "decision_analysis"
  | "market_analysis"
  | "portfolio_risk"
  | "strategy_research"
  | "backtest_help"
  | "general";

/** 需要平台事实快照的意图。其余意图不装载，省提示词预算。 */
export function intentNeedsPlatformFacts(intent: AssistantIntent) {
  return intent === "platform_info" || intent === "general";
}

/** 需要决策轮摘要的意图。 */
export function intentNeedsDecisions(intent: AssistantIntent) {
  return intent === "decision_analysis" || intent === "portfolio_risk";
}

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
  // 顺序有意义：平台事实与决策分析必须排在前面。
  // 「会员多少钱」含「员」不含策略词但含「多少钱」；若排在 strategy_research 之后，
  // 「策略卡收费吗」会因为含「策略」被判成策略研究。
  // 「这一轮为什么没开仓」含「仓」，排在 portfolio_risk 之后会被判成持仓风险。
  if (/会员|套餐|月卡|季卡|年卡|终身|价格|多少钱|收费|费用|费率|分成|积分|充值|提现|托管|平台介绍|网站|你们是|这个平台|怎么收/.test(message)) {
    return "platform_info";
  }
  if (/决策轮|决策链|七智能体|智能体|风控拒绝|为什么没开|为什么不开|为什么拒绝|决策记录|审计记录|大厅/.test(message)) {
    return "decision_analysis";
  }
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

  // 无 LLM 配置时的确定性回答。平台事实本来就来自合同常量，
  // 这条路径反而是最不会出错的——它逐字引用服务端快照。
  if (intent === "platform_info" && context.platform) {
    const facts = context.platform;
    const plans = facts.membership.plans
      .map((plan) => `${plan.name} ${plan.priceUsd} USD／${plan.durationDays === null ? "终身" : `${plan.durationDays} 天`}／${plan.aiCredits} AI 积分／绩效分成 ${(Number(plan.performanceFeeRate) * 100).toFixed(0)}%`)
      .join("；");
    return {
      text: `结论：${facts.product.name} 是${facts.product.positioning}当前处于${facts.product.stage}。\n\n关键事实：会员档位为 ${plans}。绩效分成按 ${facts.membership.performanceFee.timezone} 自然周以 ${facts.membership.performanceFee.currency} 结算，${facts.membership.performanceFee.rule}\n\n资金边界：${facts.policies.slice(0, 3).join(" ")}\n\n下一步：想了解具体某一项（会员权益、策略卡风控参数、七阶段决策流程）可以直接追问。`,
      mode: "guided_rules",
    };
  }

  if (intent === "decision_analysis") {
    const rounds = context.decisions ?? [];
    if (rounds.length === 0) {
      return {
        text: "结论：当前没有可展示的决策轮，无法解释具体判断。\n\n关键证据与失效条件：决策记录只在策略卡实际运行并产生完整决策轮后才存在；平台不会用演示数据补齐。\n\n下一步：确认已订阅官方策略卡且运行已启用，出现第一轮决策后再来问。",
        mode: "guided_rules",
      };
    }
    const latest = rounds[0];
    const why = latest.riskApproved
      ? "确定性风控允许了该结论。"
      : `确定性风控拒绝了新开仓，理由：${latest.rejectionReasons.join("；") || "未记录"}。`;
    return {
      text: `结论：最近一轮是 ${latest.strategyName} 在 ${latest.symbol} 上的决策，动作为 ${latest.action}。${why}\n\n关键证据：决策轮 ${latest.decisionRoundId}，时间 ${latest.decidedAt || "未记录"}；七阶段结论共 ${latest.stages.length} 条。\n\n失效条件：这是快照，行情与风控状态随时可能变化。\n\n下一步：到交易大厅打开该决策轮可以看到每一阶段的完整结论与审计记录。`,
      mode: "guided_rules",
    };
  }

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
