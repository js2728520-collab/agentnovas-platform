import type {
  OfficialStrategyCode,
  PaperPortfolio,
  PaperTrade,
} from "../packages/contracts/src/commercial-beta.ts";

const strategyCodes = new Set<OfficialStrategyCode>([
  "ai_conservative",
  "ai_balanced",
  "ai_aggressive",
]);
const symbols = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

function identifier(value: unknown, label: string) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 256) throw new Error(`INVALID_${label}`);
  return result;
}

function decimal12(value: unknown) {
  const result = String(value ?? "").trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(result);
  if (!match || (match[3]?.length ?? 0) > 12) throw new Error("INVALID_DECIMAL");
  const whole = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").padEnd(12, "0");
  return `${match[1]}${whole}.${fraction}`;
}

function timestamp(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_TIMESTAMP");
  return date.toISOString();
}

function strategyCode(value: unknown) {
  const result = String(value ?? "") as OfficialStrategyCode;
  if (!strategyCodes.has(result)) throw new Error("INVALID_STRATEGY_CODE");
  return result;
}

function symbol(value: unknown) {
  const result = String(value ?? "") as PaperTrade["symbol"];
  if (!symbols.has(result)) throw new Error("INVALID_SYMBOL");
  return result;
}

export function officialPaperPortfolioDto(value: unknown): PaperPortfolio {
  const row = value as Record<string, unknown>;
  const access = String(row.access ?? "");
  const status = access === "active" ? "ACTIVE"
    : access === "close_only" ? "CLOSE_ONLY"
      : access === "read_only" ? "READ_ONLY" : null;
  if (!status || !Array.isArray(row.positions)) throw new Error("INVALID_PAPER_PORTFOLIO");
  return {
    id: identifier(row.id, "PORTFOLIO_ID"),
    membershipId: identifier(row.membershipId, "MEMBERSHIP_ID"),
    strategyCode: strategyCode(row.strategyCode),
    initialCashUsdt: decimal12(row.principalUsdt),
    cashUsdt: decimal12(row.cashUsdt),
    marketValueUsdt: decimal12(row.marketValueUsdt),
    equityUsdt: decimal12(row.equityUsdt),
    realizedGrossPnlUsdt: decimal12(row.realizedGrossPnlUsdt),
    realizedPnlUsdt: decimal12(row.realizedNetPnlUsdt),
    realizedNetPnlUsdt: decimal12(row.realizedNetPnlUsdt),
    unrealizedPnlUsdt: decimal12(row.unrealizedPnlUsdt),
    feesUsdt: decimal12(row.feesUsdt),
    status,
    openPositionCount: Number(row.openPositionCount),
    positions: row.positions.map((positionValue) => {
      const position = positionValue as Record<string, unknown>;
      if (position.side !== "long") throw new Error("INVALID_PAPER_POSITION");
      return {
        id: identifier(position.id, "POSITION_ID"),
        symbol: symbol(position.symbol),
        side: "LONG" as const,
        quantity: decimal12(position.quantity),
        averageEntryPrice: decimal12(position.averageEntryPrice),
        costBasisUsdt: decimal12(position.costBasisUsdt),
        entryFeesUsdt: decimal12(position.entryFeesUsdt),
        lastMarkPrice: decimal12(position.lastMarkPrice),
        unrealizedPnlUsdt: decimal12(position.unrealizedPnlUsdt),
        openedAt: timestamp(position.openedAt),
      };
    }),
    updatedAt: timestamp(row.updatedAt),
  };
}

export function officialPaperTradeDto(value: unknown): PaperTrade {
  const row = value as Record<string, unknown>;
  const side = row.action === "buy" ? "BUY" : row.action === "sell" ? "SELL" : null;
  if (!side) throw new Error("INVALID_PAPER_TRADE");
  return {
    id: identifier(row.id, "TRADE_ID"),
    portfolioId: identifier(row.portfolioId, "PORTFOLIO_ID"),
    strategyCode: strategyCode(row.strategyCode),
    symbol: symbol(row.symbol),
    side,
    quantity: decimal12(row.quantity),
    priceUsdt: decimal12(row.fillPrice),
    notionalUsdt: decimal12(row.notionalUsdt),
    feeUsdt: decimal12(row.feeUsdt),
    allocatedEntryFeeUsdt: decimal12(row.allocatedEntryFeeUsdt),
    realizedGrossPnlUsdt: decimal12(row.realizedGrossPnlUsdt),
    realizedNetPnlUsdt: decimal12(row.realizedNetPnlUsdt),
    decisionRoundId: identifier(row.decisionRoundId, "DECISION_ROUND_ID"),
    traceId: identifier(row.traceId, "TRACE_ID"),
    filledAt: timestamp(row.filledAt),
  };
}
