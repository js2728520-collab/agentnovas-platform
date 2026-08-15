// Keep every mark local so one failed remote asset cannot replace the whole grid with HTX.
const exchangeMeta: Record<string, { label: string; slug: string }> = {
  OKX: { label: "OKX", slug: "okx" },
  BINANCE: { label: "Binance", slug: "binance" },
  BYBIT: { label: "Bybit", slug: "bybit" },
  BITGET: { label: "Bitget", slug: "bitget" },
  "GATE.IO": { label: "Gate.io", slug: "gate" },
  KUCOIN: { label: "KuCoin", slug: "kucoin" },
  COINBASE: { label: "Coinbase", slug: "coinbase" },
  KRAKEN: { label: "Kraken", slug: "kraken" },
  "CRYPTO.COM": { label: "Crypto.com", slug: "crypto-com" },
  METAMASK: { label: "MetaMask", slug: "metamask" },
  ROBINHOOD: { label: "Robinhood", slug: "robinhood" },
  HTX: { label: "HTX", slug: "htx" },
};

export function getExchangeDisplayName(name: string) {
  const key = name.trim().toUpperCase();
  return exchangeMeta[key]?.label || name.trim();
}

function BrandMark({ slug }: { slug: string }) {
  if (slug === "okx") return <span className="logo-okx" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</span>;
  if (slug === "binance") return <span className="logo-binance" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</span>;
  if (slug === "bybit") return <span className="logo-bybit" aria-hidden="true"><i /><i /><i /><i /></span>;
  if (slug === "bitget") return <span className="logo-bitget" aria-hidden="true"><i /><i /></span>;
  if (slug === "gate") return <span className="logo-gate" aria-hidden="true"><i /><i /></span>;
  if (slug === "kucoin") return <span className="logo-kucoin" aria-hidden="true"><i /><i /><i /><i /></span>;
  if (slug === "coinbase") return <span className="logo-coinbase" aria-hidden="true"><i /></span>;
  if (slug === "kraken") return <span className="logo-kraken" aria-hidden="true"><i /><i /><i /><i /></span>;
  if (slug === "crypto-com") return <span className="logo-crypto-com" aria-hidden="true"><i /></span>;
  if (slug === "metamask") return <span className="logo-metamask" aria-hidden="true"><i /></span>;
  if (slug === "robinhood") return <span className="logo-robinhood" aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false"><path d="M5 22.5c6.7-.4 12.6-3.2 17.1-8.3 1.7-1.9 3-4.1 3.9-6.7-5.7 1.1-10.1 3.4-13.3 6.9-2.6 2.8-4.1 5.8-4.5 9.1"/><path d="M8.1 24.8c4.4-4.1 8.5-7.5 12.4-10.1"/><path d="M20.8 8.3c1.8.2 3.5.8 5.2 1.7"/></svg></span>;
  return <span className="logo-htx" aria-hidden="true"><i /></span>;
}

export default function ExchangeLogo({ name, className = "" }: { name: string; className?: string }) {
  const exchange = exchangeMeta[name.toUpperCase()] || exchangeMeta.OKX;
  return (
    <span className={`exchange-brand-logo exchange-logo-${exchange.slug} ${className}`.trim()} role="img" aria-label={`${exchange.label} Logo`}>
      <BrandMark slug={exchange.slug} />
    </span>
  );
}
