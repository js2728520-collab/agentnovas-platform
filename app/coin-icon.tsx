"use client";

import { useMemo, useState } from "react";

export type ProductCategory = "crypto" | "forex" | "metals" | "stocks";

function normalizedProductSymbol(symbol: string, category: ProductCategory) {
  const compact = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const slashBase = symbol.toUpperCase().split("/")[0].replace(/[^A-Z0-9]/g, "");
  if (category === "metals") return slashBase;
  if (category !== "crypto") return compact;
  if (symbol.includes("/")) return slashBase;
  for (const quote of ["USDT", "USDC", "BUSD", "USD", "EUR", "BTC", "ETH"]) {
    if (compact.length > quote.length + 1 && compact.endsWith(quote)) return compact.slice(0, -quote.length);
  }
  return compact;
}

export function ProductIcon({ symbol, category, className = "" }: { symbol: string; category: ProductCategory; className?: string }) {
  const normalized = useMemo(() => normalizedProductSymbol(symbol, category), [symbol, category]);
  const iconKey = `${category}:${normalized}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const failed = failedKey === iconKey;
  const source = `/product-icons/${category}/${encodeURIComponent(normalized)}.svg`;
  return <i className={`product-icon coin-icon product-icon-${category} coin-icon-${normalized.toLowerCase()}${className ? ` ${className}` : ""}`} role="img" aria-label={`${normalized} icon`}>
    {!failed ? <img src={source} alt="" aria-hidden="true" onError={() => setFailedKey(iconKey)} /> : <b>{normalized.slice(0, 2)}</b>}
  </i>;
}

export default function CoinIcon({ symbol, className = "" }: { symbol: string; className?: string }) {
  return <ProductIcon symbol={symbol} category="crypto" className={className} />;
}
