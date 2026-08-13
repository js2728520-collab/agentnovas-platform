const exchangeMeta: Record<string, { label: string; slug: string }> = {
  OKX: { label: "OKX", slug: "okx" },
  BINANCE: { label: "Binance", slug: "binance" },
  BYBIT: { label: "Bybit", slug: "bybit" },
  BITGET: { label: "Bitget", slug: "bitget" },
  "GATE.IO": { label: "Gate.io", slug: "gate" },
  KUCOIN: { label: "KuCoin", slug: "kucoin" },
  COINBASE: { label: "Coinbase", slug: "coinbase" },
  KRAKEN: { label: "Kraken", slug: "kraken" },
};

function BrandMark({ slug }: { slug: string }) {
  if (slug === "okx") return <span className="logo-okx" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</span>;
  if (slug === "binance") return <span className="logo-binance" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</span>;
  if (slug === "bybit") return <span className="logo-bybit" aria-hidden="true"><i /><i /><i /><i /></span>;
  if (slug === "bitget") return <span className="logo-bitget" aria-hidden="true"><i /><i /></span>;
  if (slug === "gate") return <span className="logo-gate" aria-hidden="true"><i /><i /></span>;
  if (slug === "kucoin") return <span className="logo-kucoin" aria-hidden="true"><i /><i /><i /><i /></span>;
  if (slug === "coinbase") return <span className="logo-coinbase" aria-hidden="true"><i /></span>;
  return <span className="logo-kraken" aria-hidden="true"><i /><i /><i /><i /></span>;
}

export default function ExchangeLogo({ name, className = "" }: { name: string; className?: string }) {
  const exchange = exchangeMeta[name.toUpperCase()] || exchangeMeta.OKX;
  return <span className={`exchange-brand-logo exchange-logo-${exchange.slug} ${className}`.trim()} role="img" aria-label={`${exchange.label} Logo`}>
    <BrandMark slug={exchange.slug} />
  </span>;
}
