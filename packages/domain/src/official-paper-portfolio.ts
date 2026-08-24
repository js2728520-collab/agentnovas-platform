import {
  officialTradingHallStrategies,
  type OfficialTradingHallStrategy,
} from "../../contracts/src/trading-hall.ts";

/**
 * 模拟盘的固定本金。
 *
 * 「所有人都从 10000 USDT 起步」是**模拟盘的产品规则**——它让不同客户的收益率
 * 可以横向比较。它不是记账规则：均价、成本、已实现盈亏、手续费摊销、按本金百分比
 * 计算的配置上限，这些数学对实盘一模一样，只是本金换成客户真实投入的资金。
 *
 * 所以这个常量只在**建仓模拟盘组合**时使用，不再参与任何记账计算。
 * 记账一律读 state.principalUsdt。
 */
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
  /** 官方卡代号；社区策略跟单为 null——它不属于任何官方卡。 */
  strategyCode: StrategyCode | null;
  access: PortfolioAccess;
  /**
   * 本金。模拟盘恒为 10000，实盘是客户投入这张策略卡的真实资金。
   *
   * 曾经是字面量类型 `10_000`，于是整条记账路径在类型层面就被钉死在模拟盘上——
   * 实盘无法复用同一套记账，只能另起一套并行实现，而两套实现的分成口径迟早分叉
   * （INV-5）。放宽成 number 是让实盘走同一条路径的前提。
   */
  readonly principalUsdt: number;
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
  /**
   * 这个组合能交易什么、受什么上限约束。
   *
   * 官方卡从策略卡定义来；社区策略跟单从跟单合同的风险参数快照来（客户当初同意的那组
   * 数字）。**提成显式字段而不是按 strategyCode 查表**，理由与上面 `principalUsdt` 那条
   * 相同：不这么做，社区跟单只能另起一套并行记账，而两套实现的盈亏口径迟早分叉——
   * 而盈亏正是绩效分成的计算基础（INV-5）。
   */
  contract: PaperBookContract;
};

/** 记账所需的合同约束。字段与官方策略卡的 risk 一一对应，社区跟单填自己合同里的值。 */
export type PaperBookContract = {
  symbols: readonly string[];
  risk: {
    maxAssetAllocationPct: number;
    maxTotalAllocationPct: number;
    maxConcurrentAssets: number;
    maxNewEntriesPerDay: number;
  };
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

/** 从官方策略卡定义取合同。重建 state 的调用方用它，保证与从前逐字一致。 */
export function officialPaperBookContract(strategyCode: StrategyCode): PaperBookContract {
  const definition = definitionFor(strategyCode);
  return { symbols: [...definition.symbols], risk: { ...definition.risk } };
}

/**
 * 社区策略跟单的记账合同。
 *
 * 与官方卡走**同一套记账**（`applyOfficialPaperFill`），只是合同来源不同：官方卡来自策略卡
 * 定义，跟单来自客户当初同意的风险参数快照。另起一套并行记账会让两边的盈亏口径迟早分叉，
 * 而盈亏正是绩效分成的计算基础（INV-5）。
 *
 * `maxAssetAllocationPct` 直接用客户同意的每单占比。另外三项**必须由调用方显式给出**，
 * 这里不编默认值：它们是平台侧的操作护栏，不是客户同意过的条款，把它们藏进域层的默认值
 * 会让「客户到底同意了什么」变得说不清。
 */
export function followPaperBookContract(input: {
  symbols: readonly string[];
  capitalPct: number;
  maxTotalAllocationPct: number;
  maxConcurrentAssets: number;
  maxNewEntriesPerDay: number;
}): PaperBookContract {
  if (!input.symbols.length) throw new Error("跟单记账合同必须至少包含一个现货品种");
  if (!Number.isFinite(input.capitalPct) || input.capitalPct <= 0 || input.capitalPct > 100) {
    throw new Error("跟单每单占比无效");
  }
  return {
    symbols: [...input.symbols],
    risk: {
      maxAssetAllocationPct: input.capitalPct,
      maxTotalAllocationPct: positive(input.maxTotalAllocationPct, "跟单总仓位上限"),
      maxConcurrentAssets: positive(input.maxConcurrentAssets, "跟单并发资产上限"),
      maxNewEntriesPerDay: positive(input.maxNewEntriesPerDay, "跟单每日开仓上限"),
    },
  };
}

export function createFollowPaperPortfolioState(input: {
  contract: PaperBookContract;
  principalUsdt: number;
}): OfficialPaperPortfolioState {
  const principal = positive(input.principalUsdt, "跟单模拟盘本金");
  return {
    // 社区跟单不属于任何官方卡。这里放一个官方卡代号只是为了满足类型，会让下游误判——
    // 因此故意留空并由 contract 承载全部约束。
    strategyCode: null,
    contract: input.contract,
    access: "active",
    principalUsdt: principal,
    cashUsdt: principal,
    equityUsdt: principal,
    realizedGrossPnlUsdt: 0,
    realizedNetPnlUsdt: 0,
    realizedPnlUsdt: 0,
    unrealizedPnlUsdt: 0,
    feesUsdt: 0,
    positions: [],
    fills: [],
  };
}

export function createOfficialPaperPortfolioState(strategyCode: StrategyCode): OfficialPaperPortfolioState {
  return {
    strategyCode,
    contract: officialPaperBookContract(strategyCode),
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
  // 保留 state 自己的本金。此前这里重新盖上常量，等于把实盘组合的真实本金抹成 10000。
  return { ...state, positions, unrealizedPnlUsdt, equityUsdt };
}

export function applyOfficialPaperFill(
  state: OfficialPaperPortfolioState,
  input: {
    action: string;
    symbol: string;
    fillPrice: number;
    quoteAmountUsdt?: number;
    quantity?: number;
    /** 按费率计算手续费。模拟盘用它——模拟成交没有真实费用可言。 */
    feeRate?: number;
    /**
     * 直接给出手续费金额。实盘用它。
     *
     * 不走「反推费率再乘回去」：那条路要先除后乘，在 8 位小数上会漂，
     * 而漂掉的那部分正是客户实际付出的成本。费用记少 = 净利记多 = 分成多收。
     * 交易所回报的是金额，就按金额记。
     */
    feeUsdt?: number;
    filledAt: string;
  },
): OfficialPaperPortfolioState {
  const definition = state.contract;
  if (input.action !== "buy" && input.action !== "sell") throw new Error("官方模拟盘仅支持多头现货买卖");
  if (!definition.symbols.includes(input.symbol)) throw new Error("该策略卡仅支持其合同内的现货品种");
  if (!Number.isFinite(Date.parse(input.filledAt))) throw new Error("模拟成交时间无效");
  const symbol = input.symbol as SpotSymbol;
  const fillPrice = positive(input.fillPrice, "模拟成交价格");
  // 费率与金额二选一，不接受同时给或都不给——两者不一致时无法判断该信哪个。
  const hasRate = input.feeRate !== undefined;
  const hasAmount = input.feeUsdt !== undefined;
  if (hasRate === hasAmount) throw new Error("手续费必须且只能指定费率或金额其中之一");
  const feeRate = hasRate ? Number(input.feeRate) : 0;
  if (hasRate && (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 0.01)) {
    throw new Error("模拟手续费率无效");
  }
  const explicitFeeUsdt = hasAmount ? Number(input.feeUsdt) : 0;
  if (hasAmount && (!Number.isFinite(explicitFeeUsdt) || explicitFeeUsdt < 0)) {
    throw new Error("手续费金额无效");
  }

  if (input.action === "buy") {
    if (state.access !== "active") throw new Error("会员到期后只允许平仓，不能新增现货持仓");
    const quoteAmountUsdt = positive(Number(input.quoteAmountUsdt), "模拟买入金额");
    const existing = state.positions.find((position) => position.symbol === symbol);
    const currentCost = existing?.costBasisUsdt ?? 0;
    const currentEntryFees = existing?.entryFeesUsdt ?? 0;
    // 按本组合自己的本金算，不是按模拟盘常量。
    // 写死常量时，一个 3000 USDT 的实盘组合会被允许买到 10000 的百分比额度——
    // 风控上限静默放大 3 倍，而且不会报任何错。
    const assetLimit = state.principalUsdt * definition.risk.maxAssetAllocationPct / 100;
    if (currentCost + quoteAmountUsdt > assetLimit + 1e-8) throw new Error("模拟买入超过官方合同的单资产配置上限");
    const totalCost = state.positions.reduce((sum, position) => sum + position.costBasisUsdt, 0);
    const totalLimit = state.principalUsdt * definition.risk.maxTotalAllocationPct / 100;
    if (totalCost + quoteAmountUsdt > totalLimit + 1e-8) throw new Error("模拟买入超过官方合同的组合配置上限");
    if (!existing && state.positions.length >= definition.risk.maxConcurrentAssets) throw new Error("模拟买入超过官方合同的并发资产上限");
    const day = input.filledAt.slice(0, 10);
    if (state.fills.filter((fill) => fill.action === "buy" && fill.filledAt.startsWith(day)).length >= definition.risk.maxNewEntriesPerDay) {
      throw new Error("模拟买入超过官方合同的每日新开仓次数上限");
    }
    const feeUsdt = hasAmount ? money(explicitFeeUsdt) : money(quoteAmountUsdt * feeRate);
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
  const feeUsdt = hasAmount ? money(explicitFeeUsdt) : money(notionalUsdt * feeRate);
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
    cashUsdt: money(state.cashUsdt + notionalUsdt - feeUsdt),
    realizedGrossPnlUsdt: nextRealizedGrossPnlUsdt,
    realizedNetPnlUsdt: nextRealizedNetPnlUsdt,
    realizedPnlUsdt: nextRealizedNetPnlUsdt,
    feesUsdt: money(state.feesUsdt + feeUsdt),
    positions,
    fills,
  }, { [symbol]: fillPrice });
}
