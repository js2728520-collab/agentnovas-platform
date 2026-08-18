import { ResearchApiError } from "./research-errors.ts";

export const researchTimeframes = ["5m", "15m", "1h", "4h", "1d"] as const;
export const researchDirections = ["long_only", "short_only", "both"] as const;

export type StrategyResearchTimeframe = (typeof researchTimeframes)[number];
export type StrategyResearchDirection = (typeof researchDirections)[number];

export type StrategyResearchTarget = {
  instrumentId: string;
  symbol: string;
  timeframe: StrategyResearchTimeframe;
  direction: StrategyResearchDirection;
};

export type ParsedStrategyResearchTarget = StrategyResearchTarget & {
  source: "target" | "legacy_brief";
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, field: string, maximumLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new ResearchApiError("VALIDATION_ERROR", "研发目标缺少必填字段", 422, { fields: [field] });
  }
  if (normalized.length > maximumLength) {
    throw new ResearchApiError("VALIDATION_ERROR", `${field} 长度无效`, 422, { fields: [field] });
  }
  return normalized;
}

function normalizedSymbol(value: unknown) {
  const raw = requiredText(value, "symbol", 32);
  const symbol = raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    throw new ResearchApiError("VALIDATION_ERROR", "仅支持单个 USDT 永续合约", 422, { fields: ["symbol"] });
  }
  return symbol;
}

function normalizedInstrumentId(value: unknown) {
  const instrumentId = requiredText(value, "instrumentId", 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]*$/.test(instrumentId)) {
    throw new ResearchApiError("VALIDATION_ERROR", "永续合约标识格式无效", 422, { fields: ["instrumentId"] });
  }
  return instrumentId;
}

function normalizedTimeframe(value: unknown) {
  const timeframe = requiredText(value, "timeframe", 8).toLowerCase();
  if (!(researchTimeframes as readonly string[]).includes(timeframe)) {
    throw new ResearchApiError("VALIDATION_ERROR", "研发周期仅支持 5m、15m、1h、4h 或 1d", 422, { fields: ["timeframe"] });
  }
  return timeframe as StrategyResearchTimeframe;
}

function normalizedDirection(value: unknown) {
  const direction = requiredText(value, "direction", 16).toLowerCase();
  if (!(researchDirections as readonly string[]).includes(direction)) {
    throw new ResearchApiError("VALIDATION_ERROR", "交易方向仅支持 long_only、short_only 或 both", 422, { fields: ["direction"] });
  }
  return direction as StrategyResearchDirection;
}

export function parseStrategyResearchTarget(body: Record<string, unknown>): ParsedStrategyResearchTarget {
  const explicit = object(body.target);
  const brief = object(body.brief);
  if (!brief) {
    throw new ResearchApiError("VALIDATION_ERROR", "brief 必须是对象", 422, { fields: ["brief"] });
  }

  if (body.target !== undefined && !explicit) {
    throw new ResearchApiError("VALIDATION_ERROR", "target 必须是对象", 422, { fields: ["target"] });
  }

  if (explicit) {
    const allowed = new Set(["instrumentId", "symbol", "timeframe", "direction"]);
    const unknownFields = Object.keys(explicit).filter(key => !allowed.has(key));
    if (unknownFields.length) {
      throw new ResearchApiError("VALIDATION_ERROR", "target 包含未知字段", 422, { fields: unknownFields });
    }
    return {
      instrumentId: normalizedInstrumentId(explicit.instrumentId),
      symbol: normalizedSymbol(explicit.symbol),
      timeframe: normalizedTimeframe(explicit.timeframe),
      direction: normalizedDirection(explicit.direction),
      source: "target",
    };
  }

  const missing = ["symbol", "timeframe", "direction"].filter(field => {
    const value = brief[field];
    return typeof value !== "string" || !value.trim();
  });
  if (missing.length) {
    throw new ResearchApiError("VALIDATION_ERROR", "旧版研发请求也必须明确合约、周期和方向", 422, { fields: missing });
  }
  const symbol = normalizedSymbol(brief.symbol);
  return {
    instrumentId: symbol,
    symbol,
    timeframe: normalizedTimeframe(brief.timeframe),
    direction: normalizedDirection(brief.direction),
    source: "legacy_brief",
  };
}
