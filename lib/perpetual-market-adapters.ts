import type { HistoricalFundingRate } from "../packages/domain/src/backtest-engine.ts";
import type { StrategyCandle } from "../packages/domain/src/strategy-dsl.ts";

export type PerpetualExchange = "okx" | "binance" | "bybit";

export type DataBatch<T> = {
  items: T[];
  duplicateCount: number;
  incompleteCount: number;
  invalidCount: number;
  reversedInput: boolean;
};

export type FeeSchedule = {
  makerRate: number;
  takerRate: number;
  estimated: boolean;
  source: string;
};

export type PerpetualInstrument = {
  exchange: PerpetualExchange;
  symbol: string;
  exchangeSymbol: string;
  status: "live" | "unavailable";
  quoteAsset: "USDT";
  tickSize: number;
  lotSize: number;
  fundingIntervalHours: number;
};

const baseUrls: Record<PerpetualExchange, string> = {
  okx: "https://www.okx.com",
  binance: "https://fapi.binance.com",
  bybit: "https://api.bybit.com",
};

const timeframeMs: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

function conservativeRate(name: string, explicit: number | undefined, fallback: number) {
  const configured = explicit ?? Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 && configured <= 0.01 ? configured : fallback;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("交易所响应必须是对象");
  return value as Record<string, unknown>;
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function array(value: unknown) {
  if (!Array.isArray(value)) throw new Error("交易所响应列表格式无效");
  return value;
}

function rawCandleRows(exchange: PerpetualExchange, payload: unknown) {
  if (exchange === "binance") return array(payload);
  const root = record(payload);
  if (exchange === "okx") {
    if (root.code !== "0") throw new Error(`OKX 行情接口失败：${String(root.msg || root.code || "unknown")}`);
    return array(root.data);
  }
  if (root.retCode !== 0) throw new Error(`Bybit 行情接口失败：${String(root.retMsg || root.retCode || "unknown")}`);
  return array(record(root.result).list);
}

export function normalizeCandleBatch(
  exchange: PerpetualExchange,
  payload: unknown,
  now: number,
  intervalMs: number,
): DataBatch<StrategyCandle> {
  const rows = rawCandleRows(exchange, payload);
  const firstTime = Array.isArray(rows[0]) ? finite(rows[0][0]) : Number.NaN;
  const lastTime = Array.isArray(rows.at(-1)) ? finite((rows.at(-1) as unknown[])[0]) : Number.NaN;
  const reversedInput = Number.isFinite(firstTime) && Number.isFinite(lastTime) && firstTime > lastTime;
  const byTime = new Map<number, StrategyCandle>();
  let duplicateCount = 0;
  let incompleteCount = 0;
  let invalidCount = 0;

  for (const raw of rows) {
    if (!Array.isArray(raw)) {
      invalidCount += 1;
      continue;
    }
    const openTime = finite(raw[0]);
    const closeTime = exchange === "binance" ? finite(raw[6]) : openTime + intervalMs - 1;
    const candle = {
      openTime,
      open: finite(raw[1]),
      high: finite(raw[2]),
      low: finite(raw[3]),
      close: finite(raw[4]),
      volume: finite(raw[5]),
      closeTime,
    };
    const completeFlag = exchange !== "okx" || raw[8] === "1" || raw[8] === 1;
    if (!Object.values(candle).every(Number.isFinite)
      || candle.open <= 0
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)) {
      invalidCount += 1;
      continue;
    }
    if (!completeFlag || closeTime > now) {
      incompleteCount += 1;
      continue;
    }
    if (byTime.has(openTime)) duplicateCount += 1;
    else byTime.set(openTime, candle);
  }

  return {
    items: [...byTime.values()].sort((left, right) => left.openTime - right.openTime),
    duplicateCount,
    incompleteCount,
    invalidCount,
    reversedInput,
  };
}

function rawFundingRows(exchange: PerpetualExchange, payload: unknown) {
  if (exchange === "binance") return array(payload);
  const root = record(payload);
  if (exchange === "okx") {
    if (root.code !== "0") throw new Error(`OKX 资金费率接口失败：${String(root.msg || root.code || "unknown")}`);
    return array(root.data);
  }
  if (root.retCode !== 0) throw new Error(`Bybit 资金费率接口失败：${String(root.retMsg || root.retCode || "unknown")}`);
  return array(record(root.result).list);
}

export function normalizeFundingBatch(
  exchange: PerpetualExchange,
  payload: unknown,
): DataBatch<HistoricalFundingRate> {
  const rows = rawFundingRows(exchange, payload);
  const byTime = new Map<number, HistoricalFundingRate>();
  let duplicateCount = 0;
  let invalidCount = 0;
  const parsed = rows.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const time = finite(exchange === "bybit" ? row.fundingRateTimestamp : row.fundingTime);
    const rate = finite(row.fundingRate);
    return { time, rate };
  });
  const reversedInput = parsed.length > 1
    && Number.isFinite(parsed[0]?.time)
    && Number.isFinite(parsed.at(-1)?.time)
    && parsed[0]!.time > parsed.at(-1)!.time;
  for (const item of parsed) {
    if (!item || !Number.isFinite(item.time) || !Number.isFinite(item.rate) || Math.abs(item.rate) > 0.1) {
      invalidCount += 1;
      continue;
    }
    if (byTime.has(item.time)) duplicateCount += 1;
    else byTime.set(item.time, item);
  }
  return {
    items: [...byTime.values()].sort((left, right) => left.time - right.time),
    duplicateCount,
    incompleteCount: 0,
    invalidCount,
    reversedInput,
  };
}

function mergeBatches<T extends { openTime?: number; time?: number }>(batches: DataBatch<T>[], limit: number) {
  const items = new Map<number, T>();
  for (const batch of batches) {
    for (const item of batch.items) {
      const key = item.openTime ?? item.time;
      if (key !== undefined && !items.has(key)) items.set(key, item);
    }
  }
  const sorted = [...items.values()].sort((left, right) => (left.openTime ?? left.time ?? 0) - (right.openTime ?? right.time ?? 0));
  return {
    items: sorted.slice(-limit),
    duplicateCount: batches.reduce((sum, batch) => sum + batch.duplicateCount, 0)
      + batches.reduce((sum, batch) => sum + batch.items.length, 0) - items.size,
    incompleteCount: batches.reduce((sum, batch) => sum + batch.incompleteCount, 0),
    invalidCount: batches.reduce((sum, batch) => sum + batch.invalidCount, 0),
    reversedInput: batches.some((batch) => batch.reversedInput),
  } satisfies DataBatch<T>;
}

function exchangeSymbol(exchange: PerpetualExchange, symbol: string) {
  const normalized = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(normalized)) throw new Error("仅支持 USDT 永续交易对");
  if (exchange === "okx") return `${normalized.slice(0, -4)}-USDT-SWAP`;
  return normalized;
}

function exchangeTimeframe(exchange: PerpetualExchange, timeframe: string) {
  if (!timeframeMs[timeframe]) throw new Error("不支持的 K 线周期");
  if (exchange === "okx") return ({ "1h": "1H", "4h": "4H", "1d": "1D" } as Record<string, string>)[timeframe] || timeframe;
  if (exchange === "bybit") return ({ "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" } as Record<string, string>)[timeframe];
  return timeframe;
}

function positive(value: unknown) {
  const number = finite(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function instrumentFromRow(exchange: PerpetualExchange, raw: unknown): PerpetualInstrument | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  let rawSymbol = "";
  let symbol = "";
  let tickSize: number | null = null;
  let lotSize: number | null = null;
  let fundingIntervalHours = 8;
  let live = false;

  if (exchange === "okx") {
    rawSymbol = String(item.instId || "").toUpperCase();
    symbol = rawSymbol.replace(/-USDT-SWAP$/, "USDT").replace(/[^A-Z0-9]/g, "");
    tickSize = positive(item.tickSz);
    lotSize = positive(item.lotSz);
    live = item.state === "live" && item.settleCcy === "USDT" && /-USDT-SWAP$/.test(rawSymbol);
  } else if (exchange === "binance") {
    rawSymbol = String(item.symbol || "").toUpperCase();
    symbol = rawSymbol.replace(/[^A-Z0-9]/g, "");
    const filters = Array.isArray(item.filters) ? item.filters.filter(value => value && typeof value === "object") as Record<string, unknown>[] : [];
    tickSize = positive(filters.find(filter => filter.filterType === "PRICE_FILTER")?.tickSize);
    lotSize = positive(filters.find(filter => filter.filterType === "LOT_SIZE")?.stepSize);
    live = item.status === "TRADING"
      && item.contractType === "PERPETUAL"
      && item.quoteAsset === "USDT"
      && (item.marginAsset === undefined || item.marginAsset === "USDT");
  } else {
    rawSymbol = String(item.symbol || "").toUpperCase();
    symbol = rawSymbol.replace(/[^A-Z0-9]/g, "");
    const priceFilter = item.priceFilter && typeof item.priceFilter === "object" ? item.priceFilter as Record<string, unknown> : {};
    const lotSizeFilter = item.lotSizeFilter && typeof item.lotSizeFilter === "object" ? item.lotSizeFilter as Record<string, unknown> : {};
    tickSize = positive(priceFilter.tickSize);
    lotSize = positive(lotSizeFilter.qtyStep);
    const intervalMinutes = positive(item.fundingInterval);
    fundingIntervalHours = intervalMinutes ? intervalMinutes / 60 : 8;
    live = item.status === "Trading"
      && item.contractType === "LinearPerpetual"
      && item.quoteCoin === "USDT"
      && item.settleCoin === "USDT";
  }

  if (!live || !tickSize || !lotSize || !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return null;
  return {
    exchange,
    symbol,
    exchangeSymbol: rawSymbol,
    status: "live",
    quoteAsset: "USDT",
    tickSize,
    lotSize,
    fundingIntervalHours,
  };
}

async function defaultFetchJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`交易所接口返回 HTTP ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

export function createPerpetualMarketAdapter(exchange: PerpetualExchange, dependencies: {
  fetchJson?: (url: string) => Promise<unknown>;
  fetchAuthenticatedJson?: (url: string) => Promise<unknown>;
  now?: () => number;
  conservativeMakerRate?: number;
  conservativeTakerRate?: number;
} = {}) {
  const fetchJson = dependencies.fetchJson || defaultFetchJson;
  const now = dependencies.now || Date.now;
  const base = baseUrls[exchange];

  return {
    exchange,

    async listInstruments(input: { quote: "USDT" }) {
      if (input.quote !== "USDT") throw new Error("仅支持 USDT 永续合约目录");
      const instruments = new Map<string, PerpetualInstrument>();
      let cursor = "";
      for (let page = 0; page < (exchange === "bybit" ? 20 : 1); page += 1) {
        const url = new URL(exchange === "okx"
          ? "/api/v5/public/instruments"
          : exchange === "binance" ? "/fapi/v1/exchangeInfo" : "/v5/market/instruments-info", base);
        if (exchange === "okx") url.searchParams.set("instType", "SWAP");
        if (exchange === "bybit") {
          url.searchParams.set("category", "linear");
          url.searchParams.set("limit", "1000");
          if (cursor) url.searchParams.set("cursor", cursor);
        }
        const payload = await fetchJson(url.toString());
        let rows: unknown[];
        let nextCursor = "";
        if (exchange === "okx") {
          const root = record(payload);
          if (root.code !== "0") throw new Error(`OKX 合约接口失败：${String(root.msg || root.code || "unknown")}`);
          rows = array(root.data);
        } else if (exchange === "binance") {
          rows = array(record(payload).symbols);
        } else {
          const root = record(payload);
          if (root.retCode !== 0) throw new Error(`Bybit 合约接口失败：${String(root.retMsg || root.retCode || "unknown")}`);
          const result = record(root.result);
          rows = array(result.list);
          nextCursor = String(result.nextPageCursor || "").trim();
        }
        for (const row of rows) {
          const instrument = instrumentFromRow(exchange, row);
          if (instrument) instruments.set(instrument.exchangeSymbol, instrument);
        }
        if (exchange !== "bybit" || !nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      return [...instruments.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
    },

    async getCandles(input: { symbol: string; timeframe: string; limit: number }) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 30_000) throw new Error("K 线数量无效");
      const symbol = exchangeSymbol(exchange, input.symbol);
      const interval = exchangeTimeframe(exchange, input.timeframe);
      const batches: DataBatch<StrategyCandle>[] = [];
      let cursor: number | null = null;
      for (let page = 0; page < 100; page += 1) {
        const url = new URL(exchange === "okx"
          ? "/api/v5/market/history-candles"
          : exchange === "binance" ? "/fapi/v1/klines" : "/v5/market/kline", base);
        if (exchange === "okx") {
          url.searchParams.set("instId", symbol);
          url.searchParams.set("bar", interval);
          url.searchParams.set("limit", "300");
          if (cursor !== null) url.searchParams.set("after", String(cursor));
        } else if (exchange === "binance") {
          url.searchParams.set("symbol", symbol);
          url.searchParams.set("interval", interval);
          url.searchParams.set("limit", "1500");
          if (cursor !== null) url.searchParams.set("endTime", String(cursor - 1));
        } else {
          url.searchParams.set("category", "linear");
          url.searchParams.set("symbol", symbol);
          url.searchParams.set("interval", interval);
          url.searchParams.set("limit", "1000");
          if (cursor !== null) url.searchParams.set("end", String(cursor - 1));
        }
        const batch = normalizeCandleBatch(exchange, await fetchJson(url.toString()), now(), timeframeMs[input.timeframe]);
        batches.push(batch);
        const merged = mergeBatches(batches, input.limit);
        if (merged.items.length >= input.limit || batch.items.length === 0) return merged;
        const oldest = batch.items[0]?.openTime;
        if (oldest === undefined || oldest === cursor) return merged;
        cursor = oldest;
      }
      return mergeBatches(batches, input.limit);
    },

    async getFundingRates(input: { symbol: string; startTime: number; endTime: number; limit: number }) {
      const symbol = exchangeSymbol(exchange, input.symbol);
      const batches: DataBatch<HistoricalFundingRate>[] = [];
      let cursor = input.endTime;
      for (let page = 0; page < 100; page += 1) {
        const url = new URL(exchange === "okx"
          ? "/api/v5/public/funding-rate-history"
          : exchange === "binance" ? "/fapi/v1/fundingRate" : "/v5/market/funding/history", base);
        if (exchange === "okx") {
          url.searchParams.set("instId", symbol);
          url.searchParams.set("limit", "400");
          url.searchParams.set("before", String(cursor));
        } else if (exchange === "binance") {
          url.searchParams.set("symbol", symbol);
          url.searchParams.set("startTime", String(input.startTime));
          url.searchParams.set("endTime", String(cursor));
          url.searchParams.set("limit", "1000");
        } else {
          url.searchParams.set("category", "linear");
          url.searchParams.set("symbol", symbol);
          url.searchParams.set("startTime", String(input.startTime));
          url.searchParams.set("endTime", String(cursor));
          url.searchParams.set("limit", "200");
        }
        const batch = normalizeFundingBatch(exchange, await fetchJson(url.toString()));
        batches.push(batch);
        const merged = mergeBatches(batches, input.limit);
        if (merged.items.length >= input.limit || batch.items.length === 0 || merged.items[0]?.time <= input.startTime) return merged;
        const oldest = batch.items[0]?.time;
        if (oldest === undefined || oldest >= cursor) return merged;
        cursor = oldest - 1;
      }
      return mergeBatches(batches, input.limit);
    },

    async getFeeSchedule(input: { symbol: string }): Promise<FeeSchedule> {
      const conservative = (source: string): FeeSchedule => ({
        makerRate: conservativeRate("CONSERVATIVE_PERPETUAL_MAKER_RATE", dependencies.conservativeMakerRate, 0.0005),
        takerRate: conservativeRate("CONSERVATIVE_PERPETUAL_TAKER_RATE", dependencies.conservativeTakerRate, 0.0007),
        estimated: true,
        source,
      });
      if (!dependencies.fetchAuthenticatedJson) {
        return conservative("administrator_conservative_default");
      }
      const symbol = exchangeSymbol(exchange, input.symbol);
      const url = new URL(exchange === "okx"
        ? "/api/v5/account/trade-fee"
        : exchange === "binance" ? "/fapi/v1/commissionRate" : "/v5/account/fee-rate", base);
      if (exchange === "okx") {
        url.searchParams.set("instType", "SWAP");
        url.searchParams.set("instId", symbol);
      } else {
        if (exchange === "bybit") url.searchParams.set("category", "linear");
        url.searchParams.set("symbol", symbol);
      }
      try {
        const payload = await dependencies.fetchAuthenticatedJson(url.toString());
        let makerRate: number;
        let takerRate: number;
        if (exchange === "okx") {
          const item = record(array(record(payload).data)[0]);
          makerRate = Math.abs(finite(item.maker));
          takerRate = Math.abs(finite(item.taker));
        } else if (exchange === "binance") {
          const item = record(payload);
          makerRate = Math.abs(finite(item.makerCommissionRate));
          takerRate = Math.abs(finite(item.takerCommissionRate));
        } else {
          const item = record(array(record(record(payload).result).list)[0]);
          makerRate = Math.abs(finite(item.makerFeeRate));
          takerRate = Math.abs(finite(item.takerFeeRate));
        }
        if (![makerRate, takerRate].every(Number.isFinite)) return conservative("administrator_conservative_default_after_fee_api_failure");
        return { makerRate, takerRate, estimated: false, source: `${exchange}_authenticated_fee_api` };
      } catch {
        return conservative("administrator_conservative_default_after_fee_api_failure");
      }
    },

    async getInstrument(input: { symbol: string }): Promise<PerpetualInstrument> {
      const symbol = exchangeSymbol(exchange, input.symbol);
      const url = new URL(exchange === "okx"
        ? "/api/v5/public/instruments"
        : exchange === "binance" ? "/fapi/v1/exchangeInfo" : "/v5/market/instruments-info", base);
      if (exchange === "okx") {
        url.searchParams.set("instType", "SWAP");
        url.searchParams.set("instId", symbol);
      } else if (exchange === "bybit") {
        url.searchParams.set("category", "linear");
        url.searchParams.set("symbol", symbol);
      }
      const payload = await fetchJson(url.toString());
      let tickSize = Number.NaN;
      let lotSize = Number.NaN;
      let live = false;
      let fundingIntervalHours = 8;
      if (exchange === "okx") {
        const item = record(array(record(payload).data)[0]);
        tickSize = finite(item.tickSz);
        lotSize = finite(item.lotSz);
        live = item.state === "live" && item.settleCcy === "USDT";
      } else if (exchange === "binance") {
        const item = array(record(payload).symbols).map(record).find((candidate) => candidate.symbol === symbol);
        if (!item) throw new Error("Binance 永续合约不存在");
        tickSize = finite(array(item.filters).map(record).find((filter) => filter.filterType === "PRICE_FILTER")?.tickSize);
        lotSize = finite(array(item.filters).map(record).find((filter) => filter.filterType === "LOT_SIZE")?.stepSize);
        live = item.status === "TRADING" && item.contractType === "PERPETUAL" && item.quoteAsset === "USDT";
      } else {
        const item = record(array(record(record(payload).result).list)[0]);
        tickSize = finite(record(item.priceFilter).tickSize);
        lotSize = finite(record(item.lotSizeFilter).qtyStep);
        live = item.status === "Trading" && item.contractType === "LinearPerpetual" && item.settleCoin === "USDT";
        fundingIntervalHours = finite(item.fundingInterval) / 60 || 8;
      }
      if (!Number.isFinite(tickSize) || !Number.isFinite(lotSize)) throw new Error("交易规则响应无效");
      return {
        exchange,
        symbol: input.symbol.replace(/[^a-z0-9]/gi, "").toUpperCase(),
        exchangeSymbol: symbol,
        status: live ? "live" : "unavailable",
        quoteAsset: "USDT",
        tickSize,
        lotSize,
        fundingIntervalHours,
      };
    },
  };
}

export function assessPerpetualDataQuality(input: {
  candles: DataBatch<StrategyCandle>;
  funding: DataBatch<HistoricalFundingRate>;
  timeframe: string;
  expectedFundingIntervalHours: number;
  feeEstimated: boolean;
}) {
  const observedInterval = input.candles.items[0]
    ? input.candles.items[0].closeTime - input.candles.items[0].openTime + 1
    : timeframeMs[input.timeframe];
  const interval = observedInterval > 0 ? observedInterval : timeframeMs[input.timeframe];
  let candleGapCount = 0;
  for (let index = 1; index < input.candles.items.length; index += 1) {
    const delta = input.candles.items[index].openTime - input.candles.items[index - 1].openTime;
    if (delta > interval * 1.5) candleGapCount += Math.max(1, Math.round(delta / interval) - 1);
  }
  const fundingInterval = input.expectedFundingIntervalHours * 60 * 60_000;
  let fundingGapCount = 0;
  for (let index = 1; index < input.funding.items.length; index += 1) {
    const delta = input.funding.items[index].time - input.funding.items[index - 1].time;
    if (delta > fundingInterval * 1.5) fundingGapCount += Math.max(1, Math.round(delta / fundingInterval) - 1);
  }
  if (input.funding.items.length === 0) fundingGapCount = 1;
  const isVerifiable = candleGapCount === 0
    && fundingGapCount === 0
    && input.candles.incompleteCount === 0
    && input.candles.invalidCount === 0
    && input.funding.invalidCount === 0;
  return {
    isVerifiable,
    candleGapCount,
    fundingGapCount,
    duplicateCandleCount: input.candles.duplicateCount,
    duplicateFundingCount: input.funding.duplicateCount,
    incompleteCandleCount: input.candles.incompleteCount,
    invalidCandleCount: input.candles.invalidCount,
    invalidFundingCount: input.funding.invalidCount,
    feeEstimated: input.feeEstimated,
  };
}
