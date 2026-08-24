import {
  EQUITY_MARKETS,
  EQUITY_MARKET_DATA,
  EXCHANGE_ROLLOUT_ORDER,
  FX_METALS_SCOPE,
  type ExchangeCode,
} from "./product-parameters.ts";
import {
  normalizeMarketDescriptor,
  normalizeProviderDescriptor,
  type MarketDescriptor,
  type ProviderDescriptor,
} from "./market-data.ts";

/**
 * T2.1c 行情 provider 注册表。
 *
 * P-01/P-03 冻结后，这里第一次能写出真实的市场与 provider 清单。三条边界要写在最前面，
 * 因为它们最容易在后续切片里被悄悄突破：
 *
 * 1. **注册不等于已授权。** 每个 provider 都带 `configured`，默认 false——凭证与授权
 *    属于部署事实，不是代码事实。清单里有一家交易所，只说明我们打算接它。
 * 2. **股票首期一律延迟行情。** `executionPolicy` 恒为 `display_only`，`usage` 不含
 *    `execution`。升级为实时是运维端配置变更（P-03），但**实时也不等于可执行**——
 *    可执行要另走 live Gate。
 * 3. **外汇与贵金属只读。** P-02 确认不开放交易，因此这些市场同样 `display_only`。
 *
 * 顺序即开发与认证顺序，但每家交易所仍要独立通过 G4A；排在第一位不会让它自动解锁。
 */

/** 交易所的展示名。清单本身来自 P-01，这里只补人类可读名称。 */
const EXCHANGE_NAMES: Record<ExchangeCode, string> = {
  binance: "Binance",
  okx: "OKX",
  coinbase: "Coinbase",
  crypto_com: "Crypto.com",
  kraken: "Kraken",
  gate_io: "Gate.io",
  bitget: "Bitget",
  htx: "HTX",
};

/** 六个股票市场的交易所时区与日历。日历由交易所管理，不是连续交易。 */
const EQUITY_MARKET_META: Record<(typeof EQUITY_MARKETS)[number], {
  region: "us" | "cn" | "hk" | "kr" | "jp" | "au";
  timezone: string;
  calendarId: string;
  name: string;
}> = {
  "equities-us": { region: "us", timezone: "America/New_York", calendarId: "xnys", name: "美股" },
  "equities-cn": { region: "cn", timezone: "Asia/Shanghai", calendarId: "xshg", name: "A 股" },
  "equities-hk": { region: "hk", timezone: "Asia/Hong_Kong", calendarId: "xhkg", name: "港股" },
  "equities-kr": { region: "kr", timezone: "Asia/Seoul", calendarId: "xkrx", name: "韩股" },
  "equities-jp": { region: "jp", timezone: "Asia/Tokyo", calendarId: "xjpx", name: "日股" },
  "equities-au": { region: "au", timezone: "Australia/Sydney", calendarId: "xasx", name: "澳股" },
};

export const CRYPTO_MARKET_ID = "crypto-global";
export const FOREX_MARKET_ID = "forex-global";
export const METALS_MARKET_ID = "metals-global";

/**
 * 延迟行情的新鲜度阈值。
 *
 * 15 分钟延迟源的「新鲜」是相对它自己的延迟基线说的：数据本来就晚 15 分钟，再多晚
 * 一个周期才算陈旧。直接套用加密实时源的秒级阈值会让每一条延迟行情都被判成 stale，
 * 那样 stale Gate 就永远在响，等于没有 Gate。
 */
const DELAYED_LATENCY_TARGET_MS = EQUITY_MARKET_DATA.delayMinutes * 60_000;
const DELAYED_STALE_AFTER_MS = DELAYED_LATENCY_TARGET_MS * 2;

const REALTIME_LATENCY_TARGET_MS = EQUITY_MARKET_DATA.slaLatencyMs;
const REALTIME_STALE_AFTER_MS = 30_000;

function cryptoMarket(): MarketDescriptor {
  return normalizeMarketDescriptor({
    id: CRYPTO_MARKET_ID,
    assetClass: "crypto",
    region: "global",
    timezone: "UTC",
    calendar: { id: "crypto-24x7", kind: "continuous" },
    capabilities: ["instrument_search", "quote_snapshot", "candle_history", "realtime_stream"],
    protocols: ["rest", "websocket"],
    // 加密市场可以进入执行路径，但仍由 live Gate 决定能否真正下单。
    usage: ["display", "research", "execution"],
    executionPolicy: "live_gate_required",
  });
}

function equityMarket(id: (typeof EQUITY_MARKETS)[number]): MarketDescriptor {
  const meta = EQUITY_MARKET_META[id];
  return normalizeMarketDescriptor({
    id,
    assetClass: "equity",
    region: meta.region,
    timezone: meta.timezone,
    calendar: { id: meta.calendarId, kind: "exchange_managed" },
    // 首期延迟行情没有实时流；realtime_stream 要等实时授权到位后由配置升级加入。
    capabilities: ["instrument_search", "quote_snapshot", "candle_history"],
    protocols: ["rest"],
    // 股票首期只做展示与研究，不进入执行路径（P-03）。
    usage: ["display", "research"],
    executionPolicy: "display_only",
  });
}

function quotesOnlyMarket(id: string, assetClass: "forex" | "metal"): MarketDescriptor {
  return normalizeMarketDescriptor({
    id,
    assetClass,
    region: "global",
    timezone: "UTC",
    calendar: { id: `${assetClass}-sessions`, kind: "provider_managed" },
    capabilities: ["instrument_search", "quote_snapshot", "candle_history"],
    protocols: ["rest"],
    // P-02：只读行情，不可交易。
    usage: ["display", "research"],
    executionPolicy: "display_only",
  });
}

export function registeredMarkets(): MarketDescriptor[] {
  const markets = [cryptoMarket(), ...EQUITY_MARKETS.map(equityMarket)];
  if (FX_METALS_SCOPE.quotesEnabled) {
    markets.push(quotesOnlyMarket(FOREX_MARKET_ID, "forex"));
    markets.push(quotesOnlyMarket(METALS_MARKET_ID, "metal"));
  }
  return markets;
}

export type ExchangeProviderRegistration = ProviderDescriptor & {
  exchange: ExchangeCode;
  /** P-01 的开发与认证顺序，从 1 开始。 */
  rolloutPosition: number;
};

/**
 * 八家交易所的 provider 登记。
 *
 * `configured: false` 是有意的默认：凭证与授权是部署事实，代码里写死 true 等于宣称
 * 一个从未验证过的连接可用。`connection`/`health` 同理保持未知，由运行时探测覆盖。
 */
export function registeredExchangeProviders(): ExchangeProviderRegistration[] {
  return EXCHANGE_ROLLOUT_ORDER.map((exchange, index) => ({
    ...normalizeProviderDescriptor({
      id: `exchange-${exchange.replace(/_/g, "-")}`,
      name: EXCHANGE_NAMES[exchange],
      // 交易所行情用客户账户或平台授权取，不是公共免费源。
      authorization: "licensed",
      marketIds: [CRYPTO_MARKET_ID],
      capabilities: ["instrument_search", "quote_snapshot", "candle_history", "realtime_stream"],
      protocols: ["rest", "websocket"],
      usage: ["display", "research", "execution"],
      configured: false,
      connection: "disconnected",
      health: "unknown",
      latencyTargetMs: REALTIME_LATENCY_TARGET_MS,
      reconnectTargetMs: EQUITY_MARKET_DATA.slaReconnectSeconds * 1_000,
      staleAfterMs: REALTIME_STALE_AFTER_MS,
    }),
    exchange,
    rolloutPosition: index + 1,
  }));
}

export type EquityProviderRegistration = ProviderDescriptor & {
  marketId: (typeof EQUITY_MARKETS)[number];
  mode: "delayed" | "realtime";
  delayMinutes: number;
};

/**
 * 六个股票市场的 provider 登记。
 *
 * `provider` 在 P-03 里是「技术团队选型后报确认」，所以这里用 `equity-<market>` 这样的
 * 市场级占位 ID，而不是编一个供应商名字。选型落定后替换 ID 与 name，其余字段不变。
 */
export function registeredEquityProviders(
  mode: "delayed" | "realtime" = EQUITY_MARKET_DATA.defaultMode,
): EquityProviderRegistration[] {
  const delayed = mode === "delayed";
  return EQUITY_MARKETS.map((marketId) => ({
    ...normalizeProviderDescriptor({
      id: `equity-${marketId.replace("equities-", "")}`,
      name: `${EQUITY_MARKET_META[marketId].name}行情源`,
      authorization: "licensed",
      marketIds: [marketId],
      capabilities: delayed
        ? ["instrument_search", "quote_snapshot", "candle_history"]
        : ["instrument_search", "quote_snapshot", "candle_history", "realtime_stream"],
      protocols: delayed ? ["rest"] : ["rest", "websocket"],
      // 即使升级为实时，股票仍不进入执行路径——实时不等于可执行。
      usage: ["display", "research"],
      configured: false,
      connection: "disconnected",
      health: "unknown",
      latencyTargetMs: delayed ? DELAYED_LATENCY_TARGET_MS : REALTIME_LATENCY_TARGET_MS,
      reconnectTargetMs: EQUITY_MARKET_DATA.slaReconnectSeconds * 1_000,
      staleAfterMs: delayed ? DELAYED_STALE_AFTER_MS : REALTIME_STALE_AFTER_MS,
    }),
    marketId,
    mode,
    delayMinutes: delayed ? EQUITY_MARKET_DATA.delayMinutes : 0,
  }));
}

/**
 * 市场对客户的可见性由运维端控制（P-03）。这里只给出默认值与判定函数；实际开关存在
 * 版本化配置里，浏览器不能自报可见性。
 */
export type MarketVisibility = Record<string, boolean>;

export function defaultMarketVisibility(): MarketVisibility {
  const visibility: MarketVisibility = { [CRYPTO_MARKET_ID]: true };
  for (const marketId of EQUITY_MARKETS) visibility[marketId] = true;
  if (FX_METALS_SCOPE.quotesEnabled) {
    visibility[FOREX_MARKET_ID] = true;
    visibility[METALS_MARKET_ID] = true;
  }
  return visibility;
}

/**
 * 未登记的市场一律不可见——失败关闭。默认可见只对注册表里的市场成立，
 * 否则一个拼错的 marketId 会「默认可见」，把不该露出的市场放出去。
 */
export function isMarketVisible(marketId: string, visibility: MarketVisibility): boolean {
  const known = registeredMarkets().some((market) => market.id === marketId);
  if (!known) return false;
  return visibility[marketId] === true;
}

/** 某个市场是否允许进入执行路径。股票、外汇、贵金属恒为 false。 */
export function marketAllowsExecution(marketId: string): boolean {
  const market = registeredMarkets().find((entry) => entry.id === marketId);
  if (!market) return false;
  return market.usage.includes("execution") && market.executionPolicy !== "display_only";
}
