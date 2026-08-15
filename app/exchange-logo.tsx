import binance from "@web3icons/core/svgs/exchanges/branded/binance.svg";
import bitget from "@web3icons/core/svgs/exchanges/branded/bitget.svg";
import bybit from "@web3icons/core/svgs/exchanges/branded/bybit.svg";
import coinbase from "@web3icons/core/svgs/exchanges/branded/coinbase.svg";
import cryptoCom from "@web3icons/core/svgs/exchanges/branded/crypto-com.svg";
import gateIo from "@web3icons/core/svgs/exchanges/branded/gate-io.svg";
import kraken from "@web3icons/core/svgs/exchanges/branded/kraken.svg";
import kucoin from "@web3icons/core/svgs/exchanges/branded/kucoin.svg";
import metamask from "@web3icons/core/svgs/wallets/branded/metamask.svg";
import okx from "@web3icons/core/svgs/exchanges/branded/okx.svg";
import robinhood from "@web3icons/core/svgs/networks/branded/robinhood.svg";

type BrandSvg = string;
const htxLogoUrl = "https://upload.wikimedia.org/wikipedia/commons/c/c1/HTX_logo.png";
const okxOnDark: BrandSvg = typeof okx === "string" ? okx.replaceAll('fill="#000"', 'fill="#f5f7fb"') : okx;

const exchangeMeta: Record<string, { label: string; slug: string; svg?: BrandSvg }> = {
  OKX: { label: "OKX", slug: "okx", svg: okxOnDark },
  BINANCE: { label: "Binance", slug: "binance", svg: binance },
  BYBIT: { label: "Bybit", slug: "bybit", svg: bybit },
  BITGET: { label: "Bitget", slug: "bitget", svg: bitget },
  "GATE.IO": { label: "Gate.io", slug: "gate-io", svg: gateIo },
  KUCOIN: { label: "KuCoin", slug: "kucoin", svg: kucoin },
  COINBASE: { label: "Coinbase", slug: "coinbase", svg: coinbase },
  KRAKEN: { label: "Kraken", slug: "kraken", svg: kraken },
  "CRYPTO.COM": { label: "Crypto.com", slug: "crypto-com", svg: cryptoCom },
  METAMASK: { label: "MetaMask", slug: "metamask", svg: metamask },
  ROBINHOOD: { label: "Robinhood", slug: "robinhood", svg: robinhood },
  HTX: { label: "HTX", slug: "htx" },
};

function BrandMark({ exchange }: { exchange: (typeof exchangeMeta)[string] }) {
  if (exchange.svg) {
    return <span className="exchange-svg-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: exchange.svg }} />;
  }

  return (
    <span className="exchange-image-mark" aria-hidden="true">
      <img src={htxLogoUrl} alt="" onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.classList.add("fallback"); }} />
    </span>
  );
}

export default function ExchangeLogo({ name, className = "" }: { name: string; className?: string }) {
  const exchange = exchangeMeta[name.toUpperCase()] || exchangeMeta.OKX;
  return (
    <span className={`exchange-brand-logo exchange-logo-${exchange.slug} ${className}`.trim()} role="img" aria-label={`${exchange.label} Logo`}>
      <BrandMark exchange={exchange} />
    </span>
  );
}
