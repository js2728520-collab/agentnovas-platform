export const strategyDslVersion = 1 as const;

const allowedSymbols = new Set([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT",
  "DOTUSDT", "LTCUSDT", "BCHUSDT", "TONUSDT", "SUIUSDT",
  "APTUSDT", "NEARUSDT", "ARBUSDT", "OPUSDT", "UNIUSDT",
]);
const allowedTimeframes = new Set(["5m", "15m", "1h", "4h", "1d"]);

export type EmaCrossRule = {
  type: "ema_cross";
  fastPeriod: number;
  slowPeriod: number;
  direction: "bullish" | "bearish";
};

export type RsiThresholdRule = {
  type: "rsi_threshold";
  period: number;
  operator: "lte" | "gte";
  value: number;
};

export type ChannelBreakoutRule = {
  type: "channel_breakout";
  period: number;
  direction: "above" | "below";
};

export type VolumeRatioRule = {
  type: "volume_ratio";
  period: number;
  operator: "lte" | "gte";
  value: number;
};

export type StrategyRule =
  | EmaCrossRule
  | RsiThresholdRule
  | ChannelBreakoutRule
  | VolumeRatioRule;

export type StrategyDsl = {
  schemaVersion: 1;
  name: string;
  symbol: string;
  timeframe: string;
  side: "long_only";
  entry: { all: StrategyRule[] };
  exit: {
    any: StrategyRule[];
    stopLossPct: number;
    takeProfitPct: number;
  };
  risk: {
    positionPct: number;
    maxDrawdownPct: number;
    dailyLossLimitPct: number;
    consecutiveLossLimit: number;
  };
};

export type StrategyCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StrategyDslIssue = { path: string; message: string };

export class StrategyDslValidationError extends Error {
  readonly issues: StrategyDslIssue[];

  constructor(issues: StrategyDslIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
    this.name = "StrategyDslValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new StrategyDslValidationError([{ path, message }]);
}

function objectAt(value: unknown, path: string) {
  if (!isRecord(value)) fail(path, "必须是对象");
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path = "") {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) {
    const key = unknown[0];
    fail(path ? `${path}.${key}` : key, "不支持的字段");
  }
}

function numberAt(value: unknown, path: string, min: number, max: number, integer = false, label = "数值") {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, `${label}必须是有限数字`);
  if (integer && !Number.isInteger(value)) fail(path, `${label}必须是整数`);
  if (value < min || value > max) fail(path, `${label}必须在 ${min} 到 ${max} 之间`);
  return value;
}

function stringAt(value: unknown, path: string, maxLength: number) {
  if (typeof value !== "string") fail(path, "必须是字符串");
  const normalized = value.trim();
  if (!normalized) fail(path, "不能为空");
  if (normalized.length > maxLength) fail(path, `不能超过 ${maxLength} 个字符`);
  return normalized;
}

function normalizeSymbol(value: unknown) {
  const symbol = stringAt(value, "symbol", 24).replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!allowedSymbols.has(symbol)) fail("symbol", "当前只支持平台白名单中的主流 USDT 交易对");
  return symbol;
}

function normalizeTimeframe(value: unknown) {
  const timeframe = stringAt(value, "timeframe", 8).toLowerCase();
  if (!allowedTimeframes.has(timeframe)) fail("timeframe", "当前只支持 5m、15m、1h、4h 和 1d");
  return timeframe;
}

function normalizeRule(value: unknown, path: string): StrategyRule {
  const rule = objectAt(value, path);
  const type = rule.type;

  if (type === "ema_cross") {
    rejectUnknownKeys(rule, ["type", "fastPeriod", "slowPeriod", "direction"], path);
    const fastPeriod = numberAt(rule.fastPeriod, `${path}.fastPeriod`, 2, 200, true);
    const slowPeriod = numberAt(rule.slowPeriod, `${path}.slowPeriod`, 3, 400, true);
    if (fastPeriod >= slowPeriod) fail(`${path}.fastPeriod`, "快线周期必须小于慢线周期");
    if (rule.direction !== "bullish" && rule.direction !== "bearish") {
      fail(`${path}.direction`, "必须是 bullish 或 bearish");
    }
    return { type, fastPeriod, slowPeriod, direction: rule.direction };
  }

  if (type === "rsi_threshold") {
    rejectUnknownKeys(rule, ["type", "period", "operator", "value"], path);
    const period = numberAt(rule.period, `${path}.period`, 2, 100, true);
    const threshold = numberAt(rule.value, `${path}.value`, 1, 99);
    if (rule.operator !== "lte" && rule.operator !== "gte") fail(`${path}.operator`, "必须是 lte 或 gte");
    return { type, period, operator: rule.operator, value: threshold };
  }

  if (type === "channel_breakout") {
    rejectUnknownKeys(rule, ["type", "period", "direction"], path);
    const period = numberAt(rule.period, `${path}.period`, 2, 200, true);
    if (rule.direction !== "above" && rule.direction !== "below") fail(`${path}.direction`, "必须是 above 或 below");
    return { type, period, direction: rule.direction };
  }

  if (type === "volume_ratio") {
    rejectUnknownKeys(rule, ["type", "period", "operator", "value"], path);
    const period = numberAt(rule.period, `${path}.period`, 2, 200, true);
    const ratio = numberAt(rule.value, `${path}.value`, 0.1, 10);
    if (rule.operator !== "lte" && rule.operator !== "gte") fail(`${path}.operator`, "必须是 lte 或 gte");
    return { type, period, operator: rule.operator, value: ratio };
  }

  fail(`${path}.type`, "不支持的策略规则");
}

function normalizeRules(value: unknown, path: string, minimum: number) {
  if (!Array.isArray(value)) fail(path, "必须是数组");
  if (value.length < minimum || value.length > 4) fail(path, `规则数量必须在 ${minimum} 到 4 之间`);
  return value.map((rule, index) => normalizeRule(rule, `${path}[${index}]`));
}

export function normalizeStrategyDsl(input: unknown): StrategyDsl {
  const value = objectAt(input, "$ ".trim());
  rejectUnknownKeys(value, ["schemaVersion", "name", "symbol", "timeframe", "side", "entry", "exit", "risk"]);
  if (value.schemaVersion !== strategyDslVersion) fail("schemaVersion", "当前只支持版本 1");
  if (value.side !== "long_only") fail("side", "V1 仅支持 long_only");

  const entry = objectAt(value.entry, "entry");
  rejectUnknownKeys(entry, ["all"], "entry");
  const exit = objectAt(value.exit, "exit");
  rejectUnknownKeys(exit, ["any", "stopLossPct", "takeProfitPct"], "exit");
  const risk = objectAt(value.risk, "risk");
  rejectUnknownKeys(risk, ["positionPct", "maxDrawdownPct", "dailyLossLimitPct", "consecutiveLossLimit"], "risk");

  const stopLossPct = numberAt(exit.stopLossPct, "exit.stopLossPct", 0.1, 20);
  const takeProfitPct = numberAt(exit.takeProfitPct, "exit.takeProfitPct", 0.1, 30);
  const positionPct = numberAt(risk.positionPct, "risk.positionPct", 0.1, 30, false, "单次资金占比");
  const maxDrawdownPct = numberAt(risk.maxDrawdownPct, "risk.maxDrawdownPct", 1, 50);
  if (stopLossPct >= maxDrawdownPct) fail("exit.stopLossPct", "单笔止损必须小于最大回撤限制");

  return {
    schemaVersion: strategyDslVersion,
    name: stringAt(value.name, "name", 80),
    symbol: normalizeSymbol(value.symbol),
    timeframe: normalizeTimeframe(value.timeframe),
    side: "long_only",
    entry: { all: normalizeRules(entry.all, "entry.all", 1) },
    exit: {
      any: normalizeRules(exit.any, "exit.any", 0),
      stopLossPct,
      takeProfitPct,
    },
    risk: {
      positionPct,
      maxDrawdownPct,
      dailyLossLimitPct: numberAt(risk.dailyLossLimitPct, "risk.dailyLossLimitPct", 0.5, 20),
      consecutiveLossLimit: numberAt(risk.consecutiveLossLimit, "risk.consecutiveLossLimit", 1, 10, true),
    },
  };
}

function ema(values: number[], period: number) {
  const result = Array(values.length).fill(Number.NaN) as number[];
  if (values.length < period) return result;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function rsi(values: number[], period: number) {
  const result = Array(values.length).fill(Number.NaN) as number[];
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

function compare(value: number, operator: "lte" | "gte", threshold: number) {
  return operator === "gte" ? value >= threshold : value <= threshold;
}

export function createStrategyEvaluator(dsl: StrategyDsl, candles: StrategyCandle[]) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const emaCache = new Map<number, number[]>();
  const rsiCache = new Map<number, number[]>();
  const emaFor = (period: number) => {
    if (!emaCache.has(period)) emaCache.set(period, ema(closes, period));
    return emaCache.get(period)!;
  };
  const rsiFor = (period: number) => {
    if (!rsiCache.has(period)) rsiCache.set(period, rsi(closes, period));
    return rsiCache.get(period)!;
  };

  function condition(rule: StrategyRule, index: number) {
    if (index < 1 || index >= candles.length) return false;
    if (rule.type === "ema_cross") {
      const fast = emaFor(rule.fastPeriod);
      const slow = emaFor(rule.slowPeriod);
      if (![fast[index], slow[index], fast[index - 1], slow[index - 1]].every(Number.isFinite)) return false;
      return rule.direction === "bullish"
        ? fast[index] > slow[index] && fast[index - 1] <= slow[index - 1]
        : fast[index] < slow[index] && fast[index - 1] >= slow[index - 1];
    }
    if (rule.type === "rsi_threshold") {
      const value = rsiFor(rule.period)[index];
      return Number.isFinite(value) && compare(value, rule.operator, rule.value);
    }
    if (rule.type === "channel_breakout") {
      if (index < rule.period) return false;
      const previous = candles.slice(index - rule.period, index);
      return rule.direction === "above"
        ? candles[index].close > Math.max(...previous.map((candle) => candle.high))
        : candles[index].close < Math.min(...previous.map((candle) => candle.low));
    }
    if (index < rule.period) return false;
    const average = volumes.slice(index - rule.period, index).reduce((sum, volume) => sum + volume, 0) / rule.period;
    if (!Number.isFinite(average) || average <= 0) return false;
    return compare(volumes[index] / average, rule.operator, rule.value);
  }

  return {
    entryAt(index: number) {
      return dsl.entry.all.every((rule) => condition(rule, index));
    },
    exitAt(index: number) {
      return dsl.exit.any.some((rule) => condition(rule, index));
    },
  };
}

export function evaluateStrategyEntryAt(dsl: StrategyDsl, candles: StrategyCandle[], index: number) {
  return createStrategyEvaluator(dsl, candles).entryAt(index);
}

function finiteBriefNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

export function strategyDslFromBrief(briefInput: Record<string, unknown>): StrategyDsl {
  const style = String(briefInput.style || "趋势跟随");
  if (style === "市场中性") fail("style", "V1 暂不支持市场中性和多资产对冲策略");

  let entry: StrategyRule[];
  let exit: StrategyRule[];
  if (style === "突破动量") {
    entry = [
      { type: "channel_breakout", period: 20, direction: "above" },
      { type: "volume_ratio", period: 20, operator: "gte", value: 1.5 },
    ];
    exit = [{ type: "channel_breakout", period: 10, direction: "below" }];
  } else if (style === "区间交易") {
    entry = [{ type: "rsi_threshold", period: 14, operator: "lte", value: 30 }];
    exit = [{ type: "rsi_threshold", period: 14, operator: "gte", value: 55 }];
  } else {
    entry = [
      { type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" },
      { type: "volume_ratio", period: 20, operator: "gte", value: 1.2 },
    ];
    exit = [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" }];
  }

  const stopLossPct = finiteBriefNumber(briefInput.stopLoss, 2, 0.5, 10);
  const maxDrawdownPct = Math.max(
    stopLossPct + 0.5,
    finiteBriefNumber(briefInput.maxDrawdown, 12, 1, 30),
  );

  return normalizeStrategyDsl({
    schemaVersion: strategyDslVersion,
    name: String(briefInput.name || `${String(briefInput.symbol || "BTC/USDT")} ${style}`).slice(0, 80),
    symbol: briefInput.symbol || "BTC/USDT",
    timeframe: briefInput.period || briefInput.timeframe || "1h",
    side: "long_only",
    entry: { all: entry },
    exit: {
      any: exit,
      stopLossPct,
      takeProfitPct: finiteBriefNumber(briefInput.takeProfit, 4, 0.5, 20),
    },
    risk: {
      positionPct: finiteBriefNumber(briefInput.capital ?? briefInput.positionPct, 3, 0.5, 10),
      maxDrawdownPct,
      dailyLossLimitPct: finiteBriefNumber(briefInput.dailyLossLimitPct, 2, 0.5, 5),
      consecutiveLossLimit: Math.round(finiteBriefNumber(briefInput.consecutiveLossLimit, 3, 1, 5)),
    },
  });
}
