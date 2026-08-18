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

export type AdxThresholdRule = {
  type: "adx_threshold";
  period: number;
  operator: "lte" | "gte";
  value: number;
};

export type BollingerBandRule = {
  type: "bollinger_band";
  period: number;
  stdDev: number;
  band: "upper" | "lower";
  operator: "above" | "below";
};

export type AtrVolatilityRule = {
  type: "atr_volatility";
  period: number;
  operator: "lte" | "gte";
  valuePct: number;
};

export type StrategyRule =
  | EmaCrossRule
  | RsiThresholdRule
  | ChannelBreakoutRule
  | VolumeRatioRule
  | AdxThresholdRule
  | BollingerBandRule
  | AtrVolatilityRule;

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

export type StrategyLegV2 = {
  entry: { all: StrategyRule[] };
  exit: { any: StrategyRule[] };
  stopLossPct: number;
  takeProfitPct: number;
};

export type StrategyDslV2 = {
  schemaVersion: 2;
  name: string;
  market: "usdt_perpetual";
  marginMode: "isolated";
  leverage: 1;
  symbol: string;
  timeframe: string;
  direction: "long_only" | "short_only" | "both";
  legs: {
    long?: StrategyLegV2;
    short?: StrategyLegV2;
  };
  risk: {
    positionSizePct: number;
    maxDrawdownPct: number;
    maxDailyLossPct: number;
    maxConsecutiveLosses: number;
  };
};

export type ResearchStrategyDsl = StrategyDsl | StrategyDslV2;

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

  if (type === "adx_threshold") {
    rejectUnknownKeys(rule, ["type", "period", "operator", "value"], path);
    const period = numberAt(rule.period, `${path}.period`, 2, 100, true);
    const threshold = numberAt(rule.value, `${path}.value`, 1, 100);
    if (rule.operator !== "lte" && rule.operator !== "gte") fail(`${path}.operator`, "必须是 lte 或 gte");
    return { type, period, operator: rule.operator, value: threshold };
  }

  if (type === "bollinger_band") {
    rejectUnknownKeys(rule, ["type", "period", "stdDev", "band", "operator"], path);
    const period = numberAt(rule.period, `${path}.period`, 2, 200, true);
    const stdDev = numberAt(rule.stdDev, `${path}.stdDev`, 0.5, 5);
    if (rule.band !== "upper" && rule.band !== "lower") fail(`${path}.band`, "必须是 upper 或 lower");
    if (rule.operator !== "above" && rule.operator !== "below") fail(`${path}.operator`, "必须是 above 或 below");
    return { type, period, stdDev, band: rule.band, operator: rule.operator };
  }

  if (type === "atr_volatility") {
    rejectUnknownKeys(rule, ["type", "period", "operator", "valuePct"], path);
    const period = numberAt(rule.period, `${path}.period`, 2, 100, true);
    const valuePct = numberAt(rule.valuePct, `${path}.valuePct`, 0.1, 20);
    if (rule.operator !== "lte" && rule.operator !== "gte") fail(`${path}.operator`, "必须是 lte 或 gte");
    return { type, period, operator: rule.operator, valuePct };
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

function normalizeStrategyLegV2(value: unknown, path: string): StrategyLegV2 {
  const leg = objectAt(value, path);
  rejectUnknownKeys(leg, ["entry", "exit", "stopLossPct", "takeProfitPct"], path);
  const entry = objectAt(leg.entry, `${path}.entry`);
  rejectUnknownKeys(entry, ["all"], `${path}.entry`);
  const exit = objectAt(leg.exit, `${path}.exit`);
  rejectUnknownKeys(exit, ["any"], `${path}.exit`);
  return {
    entry: { all: normalizeRules(entry.all, `${path}.entry.all`, 1) },
    exit: { any: normalizeRules(exit.any, `${path}.exit.any`, 0) },
    stopLossPct: numberAt(leg.stopLossPct, `${path}.stopLossPct`, 0.1, 20),
    takeProfitPct: numberAt(leg.takeProfitPct, `${path}.takeProfitPct`, 0.1, 30),
  };
}

export function normalizeStrategyDslV2(input: unknown): StrategyDslV2 {
  const value = objectAt(input, "$ ".trim());
  rejectUnknownKeys(value, [
    "schemaVersion", "name", "market", "marginMode", "leverage",
    "symbol", "timeframe", "direction", "legs", "risk",
  ]);
  if (value.schemaVersion !== 2) fail("schemaVersion", "V2 策略版本必须是 2");
  if (value.market !== "usdt_perpetual") fail("market", "V2 仅支持 usdt_perpetual");
  if (value.marginMode !== "isolated") fail("marginMode", "V2 仅支持 isolated 逐仓");
  if (value.leverage !== 1) fail("leverage", "V2 杠杆固定为 1");
  if (!["long_only", "short_only", "both"].includes(String(value.direction))) {
    fail("direction", "必须是 long_only、short_only 或 both");
  }

  const direction = value.direction as StrategyDslV2["direction"];
  const legsInput = objectAt(value.legs, "legs");
  rejectUnknownKeys(legsInput, ["long", "short"], "legs");
  if ((direction === "long_only" || direction === "both") && !legsInput.long) {
    fail("legs.long", "当前方向必须提供多头腿");
  }
  if ((direction === "short_only" || direction === "both") && !legsInput.short) {
    fail("legs.short", "当前方向必须提供空头腿");
  }
  if (direction === "long_only" && legsInput.short !== undefined) fail("legs.short", "long_only 不允许空头腿");
  if (direction === "short_only" && legsInput.long !== undefined) fail("legs.long", "short_only 不允许多头腿");

  const risk = objectAt(value.risk, "risk");
  rejectUnknownKeys(risk, [
    "positionSizePct", "maxDrawdownPct", "maxDailyLossPct", "maxConsecutiveLosses",
  ], "risk");
  const maxDrawdownPct = numberAt(risk.maxDrawdownPct, "risk.maxDrawdownPct", 1, 50);
  const legs: StrategyDslV2["legs"] = {};
  if (legsInput.long !== undefined) legs.long = normalizeStrategyLegV2(legsInput.long, "legs.long");
  if (legsInput.short !== undefined) legs.short = normalizeStrategyLegV2(legsInput.short, "legs.short");
  for (const [side, leg] of Object.entries(legs)) {
    if (leg.stopLossPct >= maxDrawdownPct) {
      fail(`legs.${side}.stopLossPct`, "单笔止损必须小于最大回撤限制");
    }
  }

  return {
    schemaVersion: 2,
    name: stringAt(value.name, "name", 80),
    market: "usdt_perpetual",
    marginMode: "isolated",
    leverage: 1,
    symbol: normalizeSymbol(value.symbol),
    timeframe: normalizeTimeframe(value.timeframe),
    direction,
    legs,
    risk: {
      positionSizePct: numberAt(risk.positionSizePct, "risk.positionSizePct", 0.1, 30, false, "单次资金占比"),
      maxDrawdownPct,
      maxDailyLossPct: numberAt(risk.maxDailyLossPct, "risk.maxDailyLossPct", 0.5, 20),
      maxConsecutiveLosses: numberAt(risk.maxConsecutiveLosses, "risk.maxConsecutiveLosses", 1, 10, true),
    },
  };
}

export function normalizeResearchStrategyDsl(input: unknown): ResearchStrategyDsl {
  if (!isRecord(input)) fail("$", "必须是对象");
  if (input.schemaVersion === 1) return normalizeStrategyDsl(input);
  if (input.schemaVersion === 2) return normalizeStrategyDslV2(input);
  fail("schemaVersion", "当前只支持版本 1 或 2");
}

export function strategyDslToRuntime(input: unknown): StrategyDslV2 {
  const normalized = normalizeResearchStrategyDsl(input);
  if (normalized.schemaVersion === 2) return normalized;
  return {
    schemaVersion: 2,
    name: normalized.name,
    market: "usdt_perpetual",
    marginMode: "isolated",
    leverage: 1,
    symbol: normalized.symbol,
    timeframe: normalized.timeframe,
    direction: "long_only",
    legs: {
      long: {
        entry: normalized.entry,
        exit: { any: normalized.exit.any },
        stopLossPct: normalized.exit.stopLossPct,
        takeProfitPct: normalized.exit.takeProfitPct,
      },
    },
    risk: {
      positionSizePct: normalized.risk.positionPct,
      maxDrawdownPct: normalized.risk.maxDrawdownPct,
      maxDailyLossPct: normalized.risk.dailyLossLimitPct,
      maxConsecutiveLosses: normalized.risk.consecutiveLossLimit,
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

function atr(candles: StrategyCandle[], period: number) {
  const result = Array(candles.length).fill(Number.NaN) as number[];
  if (candles.length <= period) return result;
  const ranges = candles.map((candle, index) => index === 0
    ? candle.high - candle.low
    : Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - candles[index - 1].close),
      Math.abs(candle.low - candles[index - 1].close),
    ));
  let current = ranges.slice(1, period + 1).reduce((sum, value) => sum + value, 0) / period;
  result[period] = current;
  for (let index = period + 1; index < candles.length; index += 1) {
    current = (current * (period - 1) + ranges[index]) / period;
    result[index] = current;
  }
  return result;
}

function adx(candles: StrategyCandle[], period: number) {
  const result = Array(candles.length).fill(Number.NaN) as number[];
  if (candles.length <= period * 2) return result;
  const trueRanges = Array(candles.length).fill(0) as number[];
  const positiveDm = Array(candles.length).fill(0) as number[];
  const negativeDm = Array(candles.length).fill(0) as number[];
  for (let index = 1; index < candles.length; index += 1) {
    const up = candles[index].high - candles[index - 1].high;
    const down = candles[index - 1].low - candles[index].low;
    positiveDm[index] = up > down && up > 0 ? up : 0;
    negativeDm[index] = down > up && down > 0 ? down : 0;
    trueRanges[index] = Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - candles[index - 1].close),
      Math.abs(candles[index].low - candles[index - 1].close),
    );
  }
  let smoothedTr = trueRanges.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedPositive = positiveDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedNegative = negativeDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  const dx = Array(candles.length).fill(Number.NaN) as number[];
  for (let index = period; index < candles.length; index += 1) {
    if (index > period) {
      smoothedTr = smoothedTr - smoothedTr / period + trueRanges[index];
      smoothedPositive = smoothedPositive - smoothedPositive / period + positiveDm[index];
      smoothedNegative = smoothedNegative - smoothedNegative / period + negativeDm[index];
    }
    const plusDi = smoothedTr ? smoothedPositive / smoothedTr * 100 : 0;
    const minusDi = smoothedTr ? smoothedNegative / smoothedTr * 100 : 0;
    const denominator = plusDi + minusDi;
    dx[index] = denominator ? Math.abs(plusDi - minusDi) / denominator * 100 : 0;
  }
  const firstIndex = period * 2 - 1;
  let current = dx.slice(period, firstIndex + 1).reduce((sum, value) => sum + value, 0) / period;
  result[firstIndex] = current;
  for (let index = firstIndex + 1; index < candles.length; index += 1) {
    current = (current * (period - 1) + dx[index]) / period;
    result[index] = current;
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
  const atrCache = new Map<number, number[]>();
  const adxCache = new Map<number, number[]>();
  const emaFor = (period: number) => {
    if (!emaCache.has(period)) emaCache.set(period, ema(closes, period));
    return emaCache.get(period)!;
  };
  const rsiFor = (period: number) => {
    if (!rsiCache.has(period)) rsiCache.set(period, rsi(closes, period));
    return rsiCache.get(period)!;
  };
  const atrFor = (period: number) => {
    if (!atrCache.has(period)) atrCache.set(period, atr(candles, period));
    return atrCache.get(period)!;
  };
  const adxFor = (period: number) => {
    if (!adxCache.has(period)) adxCache.set(period, adx(candles, period));
    return adxCache.get(period)!;
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
    if (rule.type === "adx_threshold") {
      const value = adxFor(rule.period)[index];
      return Number.isFinite(value) && compare(value, rule.operator, rule.value);
    }
    if (rule.type === "bollinger_band") {
      if (index + 1 < rule.period) return false;
      const values = closes.slice(index - rule.period + 1, index + 1);
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
      const band = rule.band === "upper" ? average + deviation * rule.stdDev : average - deviation * rule.stdDev;
      return rule.operator === "above" ? closes[index] > band : closes[index] < band;
    }
    if (rule.type === "atr_volatility") {
      const value = atrFor(rule.period)[index];
      const percentage = closes[index] > 0 ? value / closes[index] * 100 : Number.NaN;
      return Number.isFinite(percentage) && compare(percentage, rule.operator, rule.valuePct);
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

export function createStrategyLegEvaluator(leg: StrategyLegV2, candles: StrategyCandle[]) {
  return createStrategyEvaluator({
    schemaVersion: 1,
    name: "runtime-leg",
    symbol: "BTCUSDT",
    timeframe: "1h",
    side: "long_only",
    entry: leg.entry,
    exit: {
      any: leg.exit.any,
      stopLossPct: leg.stopLossPct,
      takeProfitPct: leg.takeProfitPct,
    },
    risk: {
      positionPct: 1,
      maxDrawdownPct: 50,
      dailyLossLimitPct: 20,
      consecutiveLossLimit: 10,
    },
  }, candles);
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
