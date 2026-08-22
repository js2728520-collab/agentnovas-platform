import {
  officialTradingHallStrategies,
  type OfficialTradingHallStrategy,
} from "../../contracts/src/trading-hall.ts";

export const OFFICIAL_PAPER_PRINCIPAL_USDT = 10_000 as const;

type StrategyCode = OfficialTradingHallStrategy["code"];
type SpotSymbol = OfficialTradingHallStrategy["symbols"][number];
type PortfolioAccess = "active" | "close_only" | "read_only";

export type OfficialPaperPositionState = {
  symbol: SpotSymbol;
  side: "long";
  quantity: number;
  averageEntryPrice: number;
  costBasisUsdt: number;
  entryFeesUsdt: number;
  marketPrice: number;
  marketValueUsdt: number;
  unrealizedPnlUsdt: number;
};

export type OfficialPaperFillState = {
  action: "buy" | "sell";
  symbol: SpotSymbol;
  quantity: number;
  fillPrice: number;
  notionalUsdt: number;
  feeUsdt: number;
  allocatedEntryFeeUsdt: number;
  realizedGrossPnlUsdt: number;
  realizedNetPnlUsdt: number;
  filledAt: string;
};

export type OfficialPaperPortfolioState = {
  strategyCode: StrategyCode;
  access: PortfolioAccess;
  readonly principalUsdt: 10_000;
  cashUsdt: number;
  equityUsdt: number;
  realizedGrossPnlUsdt: number;
  realizedNetPnlUsdt: number;
  /** @deprecated Use realizedNetPnlUsdt. */
  realizedPnlUsdt: number;
  unrealizedPnlUsdt: number;
  feesUsdt: number;
  positions: OfficialPaperPositionState[];
  fills: OfficialPaperFillState[];
};

function definitionFor(code: StrategyCode) {
  const definition = officialTradingHallStrategies.find((item) => item.code === code);
  if (!definition) throw new Error("官方策略卡不存在");
  return definition;
}

function money(value: number) {
  if (!Number.isFinite(value)) throw new Error("模拟盘金额无效");
  return Number(value.toFixed(8));
}

function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}无效`);
  return value;
}

export function officialPaperPortfolioSeeds(input: { membershipId: string; customerId: string }) {
  if (!input.membershipId.trim() || !input.customerId.trim()) throw new Error("会员或客户标识缺失");
  return officialTradingHallStrategies.map((definition) => ({
    id: `official-paper:${input.membershipId}:${definition.code}`,
    membershipId: input.membershipId,
    customerId: input.customerId,
    strategyCode: definition.code,
    principalUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT,
    cashUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT,
    customerExchangeAccountId: null,
    risk: { ...definition.risk },
  }));
}

export function createOfficialPaperPortfolioState(strategyCode: StrategyCode): OfficialPaperPortfolioState {
  definitionFor(strategyCode);
  return {
    strategyCode,
    access: "active",
    principalUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT,
    cashUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT,
    equityUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT,
    realizedGrossPnlUsdt: 0,
    realizedNetPnlUsdt: 0,
    realizedPnlUsdt: 0,
    unrealizedPnlUsdt: 0,
    feesUsdt: 0,
    positions: [],
    fills: [],
  };
}

export function markOfficialPaperPortfolio(
  state: OfficialPaperPortfolioState,
  prices: Partial<Record<SpotSymbol, number>>,
): OfficialPaperPortfolioState {
  const positions = state.positions.map((position) => {
    const marketPrice = positive(Number(prices[position.symbol] ?? position.marketPrice), "现货标记价格");
    const marketValueUsdt = money(position.quantity * marketPrice);
    return {
      ...position,
      marketPrice,
      marketValueUsdt,
      unrealizedPnlUsdt: money(marketValueUsdt - position.costBasisUsdt),
    };
  });
  const unrealizedPnlUsdt = money(positions.reduce((sum, position) => sum + position.unrealizedPnlUsdt, 0));
  const equityUsdt = money(state.cashUsdt + positions.reduce((sum, position) => sum + position.marketValueUsdt, 0));
  return { ...state, principalUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT, positions, unrealizedPnlUsdt, equityUsdt };
}

export function applyOfficialPaperFill(
  state: OfficialPaperPortfolioState,
  input: {
    action: string;
    symbol: string;
    fillPrice: number;
    quoteAmountUsdt?: number;
    quantity?: number;
    feeRate: number;
    filledAt: string;
  },
): OfficialPaperPortfolioState {
  const definition = definitionFor(state.strategyCode);
  if (input.action !== "buy" && input.action !== "sell") throw new Error("官方模拟盘仅支持多头现货买卖");
  if (!(definition.symbols as readonly string[]).includes(input.symbol)) throw new Error("该策略卡仅支持其合同内的 BTC/ETH/SOL USDT 现货");
  if (!Number.isFinite(Date.parse(input.filledAt))) throw new Error("模拟成交时间无效");
  const symbol = input.symbol as SpotSymbol;
  const fillPrice = positive(input.fillPrice, "模拟成交价格");
  const feeRate = Number(input.feeRate);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 0.01) throw new Error("模拟手续费率无效");

  if (input.action === "buy") {
    if (state.access !== "active") throw new Error("会员到期后只允许平仓，不能新增现货持仓");
    const quoteAmountUsdt = positive(Number(input.quoteAmountUsdt), "模拟买入金额");
    const existing = state.positions.find((position) => position.symbol === symbol);
    const currentCost = existing?.costBasisUsdt ?? 0;
    const currentEntryFees = existing?.entryFeesUsdt ?? 0;
    const assetLimit = OFFICIAL_PAPER_PRINCIPAL_USDT * definition.risk.maxAssetAllocationPct / 100;
    if (currentCost + quoteAmountUsdt > assetLimit + 1e-8) throw new Error("模拟买入超过官方合同的单资产配置上限");
    const totalCost = state.positions.reduce((sum, position) => sum + position.costBasisUsdt, 0);
    const totalLimit = OFFICIAL_PAPER_PRINCIPAL_USDT * definition.risk.maxTotalAllocationPct / 100;
    if (totalCost + quoteAmountUsdt > totalLimit + 1e-8) throw new Error("模拟买入超过官方合同的组合配置上限");
    if (!existing && state.positions.length >= definition.risk.maxConcurrentAssets) throw new Error("模拟买入超过官方合同的并发资产上限");
    const day = input.filledAt.slice(0, 10);
    if (state.fills.filter((fill) => fill.action === "buy" && fill.filledAt.startsWith(day)).length >= definition.risk.maxNewEntriesPerDay) {
      throw new Error("模拟买入超过官方合同的每日新开仓次数上限");
    }
    const feeUsdt = money(quoteAmountUsdt * feeRate);
    if (quoteAmountUsdt + feeUsdt > state.cashUsdt + 1e-8) throw new Error("模拟盘可用现金不足");
    const quantity = money(quoteAmountUsdt / fillPrice);
    const nextQuantity = money((existing?.quantity ?? 0) + quantity);
    const nextCost = money(currentCost + quoteAmountUsdt);
    const nextPosition: OfficialPaperPositionState = {
      symbol,
      side: "long",
      quantity: nextQuantity,
      averageEntryPrice: money(nextCost / nextQuantity),
      costBasisUsdt: nextCost,
      entryFeesUsdt: money(currentEntryFees + feeUsdt),
      marketPrice: fillPrice,
      marketValueUsdt: nextCost,
      unrealizedPnlUsdt: 0,
    };
    const positions = existing
      ? state.positions.map((position) => position.symbol === symbol ? nextPosition : position)
      : [...state.positions, nextPosition];
    const cashUsdt = money(state.cashUsdt - quoteAmountUsdt - feeUsdt);
    const fills = [...state.fills, {
      action: "buy" as const, symbol, quantity, fillPrice, notionalUsdt: quoteAmountUsdt,
      feeUsdt, allocatedEntryFeeUsdt: 0, realizedGrossPnlUsdt: 0,
      realizedNetPnlUsdt: 0, filledAt: input.filledAt,
    }];
    return markOfficialPaperPortfolio({
      ...state,
      principalUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT,
      cashUsdt,
      feesUsdt: money(state.feesUsdt + feeUsdt),
      positions,
      fills,
    }, { [symbol]: fillPrice });
  }

  if (state.access === "read_only") throw new Error("模拟盘已进入只读状态");
  const existing = state.positions.find((position) => position.symbol === symbol);
  if (!existing) throw new Error("模拟平仓不存在对应多头现货持仓");
  const quantity = positive(Number(input.quantity ?? existing.quantity), "模拟卖出数量");
  if (quantity > existing.quantity + 1e-12) throw new Error("模拟卖出数量超过持仓");
  const notionalUsdt = money(quantity * fillPrice);
  const feeUsdt = money(notionalUsdt * feeRate);
  const releasedCost = money(existing.costBasisUsdt * quantity / existing.quantity);
  const allocatedEntryFeeUsdt = money(existing.entryFeesUsdt * quantity / existing.quantity);
  const realizedGrossPnlUsdt = money(notionalUsdt - releasedCost);
  const realizedNetPnlUsdt = money(realizedGrossPnlUsdt - allocatedEntryFeeUsdt - feeUsdt);
  const remainingQuantity = money(existing.quantity - quantity);
  const positions = remainingQuantity <= 1e-12
    ? state.positions.filter((position) => position.symbol !== symbol)
    : state.positions.map((position) => position.symbol === symbol ? {
      ...position,
      quantity: remainingQuantity,
      costBasisUsdt: money(position.costBasisUsdt - releasedCost),
      entryFeesUsdt: money(position.entryFeesUsdt - allocatedEntryFeeUsdt),
      marketPrice: fillPrice,
      marketValueUsdt: money(remainingQuantity * fillPrice),
    } : position);
  const fills = [...state.fills, {
    action: "sell" as const, symbol, quantity, fillPrice, notionalUsdt, feeUsdt,
    allocatedEntryFeeUsdt, realizedGrossPnlUsdt, realizedNetPnlUsdt,
    filledAt: input.filledAt,
  }];
  const nextRealizedGrossPnlUsdt = money(state.realizedGrossPnlUsdt + realizedGrossPnlUsdt);
  const nextRealizedNetPnlUsdt = money(state.realizedNetPnlUsdt + realizedNetPnlUsdt);
  return markOfficialPaperPortfolio({
    ...state,
    principalUsdt: OFFICIAL_PAPER_PRINCIPAL_USDT,
    cashUsdt: money(state.cashUsdt + notionalUsdt - feeUsdt),
    realizedGrossPnlUsdt: nextRealizedGrossPnlUsdt,
    realizedNetPnlUsdt: nextRealizedNetPnlUsdt,
    realizedPnlUsdt: nextRealizedNetPnlUsdt,
    feesUsdt: money(state.feesUsdt + feeUsdt),
    positions,
    fills,
  }, { [symbol]: fillPrice });
}
