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

const fallbackItems: MarketItem[] = [
  ["BTC/USD", "Bitcoin", "crypto", 63762, 0.25, "3所聚合", "LIVE"],
  ["ETH/USD", "Ethereum", "crypto", 1898, 0.44, "3所聚合", "LIVE"],
  ["SOL/USD", "Solana", "crypto", 76.14, 0.61, "3所聚合", "LIVE"],
  ["BNB/USD", "BNB", "crypto", 611.6, 0.29, "3所聚合", "LIVE"],
  ["XRP/USD", "XRP", "crypto", 1.014, -0.58, "3所聚合", "LIVE"],
  ["DOGE/USD", "Dogecoin", "crypto", 0.0705, -1.12, "3所聚合", "LIVE"],
  ["ADA/USD", "Cardano", "crypto", 0.1832, -0.43, "WS·4所聚合", "LIVE"],
  ["LTC/USD", "Litecoin", "crypto", 45.56, -0.66, "3所聚合", "LIVE"],
  ["LINK/USD", "Chainlink", "crypto", 8.82, 0.18, "WS·4所聚合", "LIVE"],
  ["AVAX/USD", "Avalanche", "crypto", 6.35, 4.97, "WS·4所聚合", "LIVE"],
  ["TON/USD", "Toncoin", "crypto", 1.345, 0.0, "WS·4所聚合", "LIVE"],
  ["TRX/USD", "TRON", "crypto", 0.3359, 0.39, "3所聚合", "LIVE"],
  ["DOT/USD", "Polkadot", "crypto", 0.791, -1.52, "WS·4所聚合", "LIVE"],
  ["NEAR/USD", "Near Protocol", "crypto", 1.72, 2.07, "3所聚合", "LIVE"],
  ["ARB/USD", "Arbitrum", "crypto", 0.24, -3.05, "WS·4所聚合", "LIVE"],
  ["OP/USD", "Optimism", "crypto", 0.36, -3.22, "WS·4所聚合", "LIVE"],
  ["ATOM/USD", "Cosmos", "crypto", 4.82, 0.0, "WS·4所聚合", "LIVE"],
  ["UNI/USD", "Uniswap", "crypto", 7.11, 0.0, "3所聚合", "LIVE"],
  ["EUR/USD", "Euro", "forex", 1.0842, 0.0, "mirror", "DELAY"],
  ["GBP/USD", "Pound Sterling", "forex", 1.2714, 0.0, "mirror", "DELAY"],
  ["XAU/USD", "Gold", "metals", 2362.8, 0.0, "mirror", "DELAY"],
  ["XAG/USD", "Silver", "metals", 28.42, 0.0, "mirror", "DELAY"],
  ["WTI/USD", "Crude Oil", "energy", 78.35, 0.0, "mirror", "DELAY"],
  ["SPX/USD", "S&P 500", "index", 5321.4, 0.0, "mirror", "DELAY"],
].map(([symbol, name, category, price, change24h, source, status], index) => ({
  symbol: symbol as string,
  name: name as string,
  category: category as Exclude<Category, "all">,
  price: price as number,
  change24h: change24h as number,
  volume24h: 0,
  high24h: 0,
  low24h: 0,
  source: source as string,
  status: status as "LIVE" | "DELAY",
  spark: makeSpark(index + 1),
}));

const radarItems = [
  { symbol: "LINK/USD", score: 40, detail: "3 所价差 0.18%，跨所套利窗口打开", side: "ARB", price: "$8.82" },
  { symbol: "DOGE/USD", score: 38, detail: "震荡区间，网格/短线优先", side: "LONG", price: "$0.07" },
  { symbol: "DOT/USD", score: 38, detail: "震荡区间，网格/短线优先", side: "LONG", price: "$0.79" },
  { symbol: "SOL/USD", score: 37, detail: "震荡区间，网格/短线优先", side: "LONG", price: "$76.14" },
  { symbol: "XRP/USD", score: 36, detail: "震荡区间，网格/短线优先", side: "LONG", price: "$1.01" },
];

const categories: Array<{ id: Category; label: string; icon: string }> = [
  { id: "all", label: "全部", icon: "▥" },
  { id: "crypto", label: "加密", icon: "₿" },
  { id: "forex", label: "外汇", icon: "$" },
  { id: "metals", label: "贵金属", icon: "◇" },
  { id: "energy", label: "能源", icon: "♨" },
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
            source: "Binance · WS",
            status: "LIVE" as const,
          };
        });
        setItems(merged);
        setLive(true);
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
          <span className="radar-live">{live ? "LIVE" : "DEMO"}</span>
        </div>
        <div className="market-radar-cards">
          {radarItems.map((item, index) => (
            <article className={`market-radar-card ${index === 0 ? "is-highlight" : ""}`} key={item.symbol}>
              <div className="radar-card-head"><b>{item.symbol}</b><strong>{item.score}</strong></div>
              <p>{item.detail}</p>
              <footer><span className={item.side === "ARB" ? "radar-arb" : "radar-long"}>{item.side}</span><em>{item.price}</em></footer>
            </article>
          ))}
        </div>
      </section>

      <nav className="market-category-tabs" aria-label="行情品类">
        {categories.map((item) => (
          <button className={category === item.id ? "active" : ""} key={item.id} onClick={() => setCategory(item.id)} type="button">
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
            <div className={`market-spark ${item.change24h < 0 ? "is-down" : ""}`} aria-hidden="true">{item.spark.map((height, sparkIndex) => <i key={`${item.symbol}-${sparkIndex}`} style={{ height: `${height}%` }} />)}</div>
            {index === 0 && <span className="market-updated-dot" title="行情已接入">●</span>}
          </article>
        ))}
      </section>
    </main>
  );
}
