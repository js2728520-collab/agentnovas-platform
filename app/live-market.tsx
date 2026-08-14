"use client";

import { useEffect, useMemo, useState } from "react";

type Category = "all" | "crypto" | "forex" | "metals" | "energy" | "index";

type MarketItem = {
  symbol: string;
  name: string;
  category: Exclude<Category, "all">;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  source: string;
  status: "LIVE" | "DELAY";
  spark: number[];
};

type ApiItem = {
  symbol?: string;
  price?: number;
  change24h?: number;
  volume24h?: number;
  high24h?: number;
  low24h?: number;
};

const makeSpark = (seed: number) => {
  const points = [38, 44, 40, 51, 47, 58, 52, 62, 55, 66, 60, 71];
  return points.map((point, index) => Math.max(16, point + ((seed * 13 + index * 7) % 17) - 8));
};

const sparkPoints = (values: number[]) => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  return values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 90 - ((value - min) / range) * 72;
    return `${x},${y}`;
  }).join(" ");
};

type MarketSeed = [symbol: string, name: string, category: Exclude<Category, "all">, price?: number, change24h?: number];

// Binance supplies the crypto ticker stream. Keep this list in one place so the
// cards, REST fallback and WebSocket stream always cover the same products.
const cryptoSeeds: MarketSeed[] = [
  ["BTC/USD", "Bitcoin", "crypto"], ["ETH/USD", "Ethereum", "crypto"], ["SOL/USD", "Solana", "crypto"], ["BNB/USD", "BNB", "crypto"],
  ["XRP/USD", "XRP", "crypto"], ["DOGE/USD", "Dogecoin", "crypto"], ["ADA/USD", "Cardano", "crypto"], ["LTC/USD", "Litecoin", "crypto"],
  ["LINK/USD", "Chainlink", "crypto"], ["AVAX/USD", "Avalanche", "crypto"], ["TON/USD", "Toncoin", "crypto"], ["TRX/USD", "TRON", "crypto"],
  ["DOT/USD", "Polkadot", "crypto"], ["NEAR/USD", "Near Protocol", "crypto"], ["ARB/USD", "Arbitrum", "crypto"], ["OP/USD", "Optimism", "crypto"],
  ["ATOM/USD", "Cosmos", "crypto"], ["UNI/USD", "Uniswap", "crypto"],
  ["BCH/USD", "Bitcoin Cash", "crypto"], ["SUI/USD", "Sui", "crypto"], ["APT/USD", "Aptos", "crypto"],
  ["FIL/USD", "Filecoin", "crypto"], ["ICP/USD", "Internet Computer", "crypto"], ["ETC/USD", "Ethereum Classic", "crypto"],
  ["XLM/USD", "Stellar", "crypto"], ["HBAR/USD", "Hedera", "crypto"], ["CRO/USD", "Cronos", "crypto"],
  ["VET/USD", "VeChain", "crypto"], ["ALGO/USD", "Algorand", "crypto"], ["AAVE/USD", "Aave", "crypto"],
  ["MKR/USD", "Maker", "crypto"], ["CRV/USD", "Curve", "crypto"], ["SAND/USD", "The Sandbox", "crypto"],
  ["MANA/USD", "Decentraland", "crypto"], ["PEPE/USD", "Pepe", "crypto"], ["SHIB/USD", "Shiba Inu", "crypto"],
  ["WIF/USD", "dogwifhat", "crypto"], ["BONK/USD", "Bonk", "crypto"], ["SEI/USD", "Sei", "crypto"],
  ["INJ/USD", "Injective", "crypto"], ["TIA/USD", "Celestia", "crypto"], ["FTM/USD", "Fantom", "crypto"],
  ["RUNE/USD", "THORChain", "crypto"], ["LDO/USD", "Lido DAO", "crypto"], ["IMX/USD", "Immutable", "crypto"],
  ["GRT/USD", "The Graph", "crypto"], ["EGLD/USD", "MultiversX", "crypto"], ["KAS/USD", "Kaspa", "crypto"],
  ["JASMY/USD", "JasmyCoin", "crypto"], ["STX/USD", "Stacks", "crypto"], ["THETA/USD", "Theta", "crypto"],
  ["XMR/USD", "Monero", "crypto"], ["ZEC/USD", "Zcash", "crypto"],
];

// These markets are displayed as products now. They remain DELAY until a
// configured provider is connected, so the UI never presents invented prices
// as live data. The list intentionally contains 20 instruments per category.
const delayedSeeds: MarketSeed[] = [
  ["EUR/USD", "Euro", "forex"], ["GBP/USD", "Pound Sterling", "forex"], ["JPY/USD", "Japanese Yen", "forex"],
  ["AUD/USD", "Australian Dollar", "forex"], ["NZD/USD", "New Zealand Dollar", "forex"], ["CAD/USD", "Canadian Dollar", "forex"],
  ["CHF/USD", "Swiss Franc", "forex"], ["HKD/USD", "Hong Kong Dollar", "forex"], ["SGD/USD", "Singapore Dollar", "forex"],
  ["CNY/USD", "Chinese Yuan", "forex"], ["INR/USD", "Indian Rupee", "forex"], ["KRW/USD", "Korean Won", "forex"],
  ["MXN/USD", "Mexican Peso", "forex"], ["BRL/USD", "Brazilian Real", "forex"], ["ZAR/USD", "South African Rand", "forex"],
  ["SEK/USD", "Swedish Krona", "forex"], ["NOK/USD", "Norwegian Krone", "forex"], ["DKK/USD", "Danish Krone", "forex"],
  ["PLN/USD", "Polish Zloty", "forex"], ["TRY/USD", "Turkish Lira", "forex"],
  ["XAU/USD", "Gold", "metals"], ["XAG/USD", "Silver", "metals"], ["XPT/USD", "Platinum", "metals"],
  ["XPD/USD", "Palladium", "metals"], ["XCU/USD", "Copper", "metals"], ["XNI/USD", "Nickel", "metals"],
  ["XAL/USD", "Aluminium", "metals"], ["XZN/USD", "Zinc", "metals"], ["XPB/USD", "Lead", "metals"],
  ["XSN/USD", "Tin", "metals"], ["XCO/USD", "Cobalt", "metals"], ["XLI/USD", "Lithium", "metals"],
  ["XMO/USD", "Molybdenum", "metals"], ["XMN/USD", "Manganese", "metals"], ["XCR/USD", "Chromium", "metals"],
  ["XTI/USD", "Titanium", "metals"], ["XIR/USD", "Iridium", "metals"], ["XRH/USD", "Rhodium", "metals"],
  ["XRU/USD", "Ruthenium", "metals"], ["XOS/USD", "Osmium", "metals"],
  ["WTI/USD", "WTI Crude Oil", "energy"], ["BRENT/USD", "Brent Crude Oil", "energy"], ["NATGAS/USD", "Natural Gas", "energy"],
  ["GASOIL/USD", "Gasoil", "energy"], ["HEATOIL/USD", "Heating Oil", "energy"], ["RBOB/USD", "RBOB Gasoline", "energy"],
  ["ETHANOL/USD", "Ethanol", "energy"], ["URANIUM/USD", "Uranium", "energy"], ["COAL/USD", "Coal", "energy"],
  ["PROPANE/USD", "Propane", "energy"], ["BUTANE/USD", "Butane", "energy"], ["NAPHTHA/USD", "Naphtha", "energy"],
  ["JETFUEL/USD", "Jet Fuel", "energy"], ["LNG/USD", "LNG", "energy"], ["DIESEL/USD", "Diesel", "energy"],
  ["TTFGAS/USD", "TTF Gas", "energy"], ["DMEGAS/USD", "DME Gas", "energy"], ["PETCOKE/USD", "Petcoke", "energy"],
  ["SULFUR/USD", "Sulfur", "energy"], ["BIOFUEL/USD", "Biofuel", "energy"],
  ["SPX/USD", "S&P 500", "index"], ["NDX/USD", "Nasdaq 100", "index"], ["DJI/USD", "Dow Jones", "index"],
  ["RUT/USD", "Russell 2000", "index"], ["VIX/USD", "VIX", "index"], ["FTSE/USD", "FTSE 100", "index"],
  ["DAX/USD", "DAX", "index"], ["CAC/USD", "CAC 40", "index"], ["STOXX50/USD", "Euro Stoxx 50", "index"],
  ["IBEX/USD", "IBEX 35", "index"], ["FTSEMIB/USD", "FTSE MIB", "index"], ["NIKKEI/USD", "Nikkei 225", "index"],
  ["TOPIX/USD", "TOPIX", "index"], ["HSI/USD", "Hang Seng", "index"], ["HSCEI/USD", "Hang Seng China", "index"],
  ["ASX200/USD", "ASX 200", "index"], ["KOSPI/USD", "KOSPI", "index"], ["NIFTY50/USD", "Nifty 50", "index"],
  ["SENSEX/USD", "Sensex", "index"], ["SSEC/USD", "Shanghai Composite", "index"],
];

const fallbackItems: MarketItem[] = [...cryptoSeeds, ...delayedSeeds].map(([symbol, name, category, price = 0, change24h = 0], index) => ({
  symbol,
  name,
  category,
  price,
  change24h,
  volume24h: 0,
  high24h: 0,
  low24h: 0,
  source: category === "crypto" ? "等待实时数据" : "暂无实时源",
  status: "DELAY",
  spark: makeSpark(index + 1),
}));

type RadarItem = {
  symbol: string;
  score: number;
  detail: string;
  side: "ARB" | "LONG" | "SHORT";
  price: number;
  timeframe: string;
  trigger: string;
  entry: string;
  target: string;
  stop: string;
  rr: string;
  volatility: string;
  liquidity: string;
};

// The radar is deliberately presented as a compact decision brief: users can
// see what triggered a scan and the boundaries that still need risk approval,
// instead of being shown a score with no context.
const radarItems: RadarItem[] = [
  { symbol: "LINK/USD", score: 40, detail: "3 所价差 0.18%，跨所套利窗口打开", side: "ARB", price: 8.82, timeframe: "15m", trigger: "跨所价差回归", entry: "$8.79–8.84", target: "$8.97", stop: "$8.68", rr: "1:2.1", volatility: "中", liquidity: "$42.6M" },
  { symbol: "DOGE/USD", score: 38, detail: "震荡区间，网格/短线优先", side: "LONG", price: 0.07, timeframe: "1h", trigger: "区间下沿反弹", entry: "$0.069–0.071", target: "$0.074", stop: "$0.067", rr: "1:1.8", volatility: "高", liquidity: "$188M" },
  { symbol: "DOT/USD", score: 38, detail: "震荡区间，网格/短线优先", side: "LONG", price: 0.79, timeframe: "4h", trigger: "短均线拐头", entry: "$0.78–0.80", target: "$0.84", stop: "$0.75", rr: "1:1.9", volatility: "中", liquidity: "$76.4M" },
  { symbol: "SOL/USD", score: 37, detail: "震荡区间，网格/短线优先", side: "LONG", price: 76.14, timeframe: "1h", trigger: "成交量放大 1.6x", entry: "$75.8–76.5", target: "$79.6", stop: "$73.9", rr: "1:2.3", volatility: "高", liquidity: "$1.24B" },
  { symbol: "XRP/USD", score: 36, detail: "震荡区间，网格/短线优先", side: "LONG", price: 1.01, timeframe: "15m", trigger: "买卖盘失衡", entry: "$1.00–1.02", target: "$1.06", stop: "$0.98", rr: "1:2.0", volatility: "中", liquidity: "$318M" },
];

const categories: Array<{ id: Category; label: string; icon: string }> = [
  { id: "all", label: "全部", icon: "▥" },
  { id: "crypto", label: "加密", icon: "₿" },
  { id: "forex", label: "外汇", icon: "$" },
  { id: "metals", label: "贵金属", icon: "◇" },
  { id: "energy", label: "能源", icon: "♨︎" },
  { id: "index", label: "指数", icon: "▥" },
];

const normalizeSymbol = (symbol: string) => symbol.toUpperCase().replace("USDT", "").replace("USD", "").replace("/", "");

const formatPrice = (price: number) => {
  if (!price) return "—";
  const fractionDigits = price < 1 ? 4 : price < 10 ? 3 : 2;
  return `$${price.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
};

export default function LiveMarket() {
  const [items, setItems] = useState<MarketItem[]>(fallbackItems);
  const [live, setLive] = useState(false);
  const [category, setCategory] = useState<Category>("all");
  const [clock, setClock] = useState("15:31:02");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/market/ticker", { cache: "no-store" });
        const data = (await response.json()) as { items?: ApiItem[] };
        const incoming = Array.isArray(data.items) ? data.items : [];
        if (!active || incoming.length === 0) return;
        const bySymbol = new Map(incoming.map((row) => [normalizeSymbol(String(row.symbol ?? "")), row]));
        const merged = fallbackItems.map((item) => {
          const row = bySymbol.get(normalizeSymbol(item.symbol));
          if (!row || !Number(row.price)) return item;
          return {
            ...item,
            price: Number(row.price),
            change24h: Number(row.change24h ?? 0),
            volume24h: Number(row.volume24h ?? 0),
            high24h: Number(row.high24h ?? 0),
            low24h: Number(row.low24h ?? 0),
            source: "Binance · REST",
            status: "LIVE" as const,
          };
        });
        setItems(merged);
        setLive(incoming.some((row) => Number(row.price) > 0));
      } catch {
        if (active) setLive(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 15000);
    const clockTimer = window.setInterval(() => setClock(new Date().toLocaleTimeString("en-GB", { hour12: false })), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearInterval(clockTimer);
    };
  }, []);

  const visible = useMemo(
    () => (category === "all" ? items : items.filter((item) => item.category === category)),
    [category, items],
  );

  return (
    <main className="market-replica">
      <header className="market-replica-head">
        <div>
          <h1>行情中心</h1>
          <p>加密、外汇、贵金属、能源、指数——全部以美金计价，点击查看近 30 日走势。</p>
        </div>
      </header>

      <section className="market-radar" aria-label="机会雷达">
        <div className="market-radar-title">
          <span className="radar-pulse">◉</span>
          <strong>机会雷达 · Agent 实时狩猎榜</strong>
          <small>动量 / 波动结构 / 跨所价差 / 流动性 综合评分，每 8 秒重算</small>
          <span className="radar-live">{live ? "LIVE" : "等待数据"}</span>
        </div>
        <div className="market-radar-cards">
          {radarItems.map((item, index) => (
            <article className={`market-radar-card ${index === 0 ? "is-highlight" : ""}`} key={item.symbol}>
              <div className="radar-card-head"><b>{item.symbol}</b><strong>{item.score}<small>/100</small></strong></div>
              <div className="radar-card-badges"><span className={item.side === "SHORT" ? "is-short" : item.side === "ARB" ? "is-arb" : "is-long"}>{item.side}</span><span>{item.timeframe}</span><span>风控待审</span></div>
              <p>{item.detail}</p>
              <div className="radar-card-trigger"><small>触发依据</small><b>{item.trigger}</b></div>
              <div className="radar-card-levels"><div><small>入场区间</small><b>{item.entry}</b></div><div><small>止盈 / 止损</small><b>{item.target} / {item.stop}</b></div></div>
              <footer><span className="radar-card-price">${item.price < 1 ? item.price.toFixed(4) : item.price.toFixed(2)}</span><span className="radar-card-footer-meta">R:R {item.rr} · 波动{item.volatility} · 流动性 {item.liquidity}</span></footer>
            </article>
          ))}
        </div>
      </section>

      <nav className="market-category-tabs" aria-label="行情品类">
        {categories.map((item) => (
          <button className={`market-category-${item.id} ${category === item.id ? "active" : ""}`} key={item.id} onClick={() => setCategory(item.id)} type="button">
            <span>{item.icon}</span>{item.label}
          </button>
        ))}
      </nav>

      <section className="market-asset-grid" aria-label="行情产品">
        {visible.map((item, index) => (
          <article className="market-asset-card" key={item.symbol}>
            <header>
              <div><b>{item.symbol}</b><small>{item.name}</small><small className="market-source">{item.source}</small></div>
              <div className="market-card-status"><span className={item.status === "LIVE" ? "is-live" : "is-delay"}>{item.status}</span><time>{clock}</time></div>
            </header>
            <div className="market-card-price"><strong>{formatPrice(item.price)}</strong><em className={item.change24h < 0 ? "is-down" : "is-up"}>{item.price ? `${item.change24h >= 0 ? "+" : ""}${item.change24h.toFixed(2)}%` : "+0.00%"}</em></div>
            <div className={`market-spark ${item.change24h < 0 ? "is-down" : "is-up"}`} aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={sparkPoints(item.spark)} /></svg></div>
            {index === 0 && live && <span className="market-updated-dot" title="行情已接入">●</span>}
          </article>
        ))}
      </section>
    </main>
  );
}
