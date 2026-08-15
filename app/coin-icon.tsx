import btcIcon from "@web3icons/core/svgs/tokens/branded/BTC.svg";
import ethIcon from "@web3icons/core/svgs/tokens/branded/ETH.svg";
import solIcon from "@web3icons/core/svgs/tokens/branded/SOL.svg";
import bnbIcon from "@web3icons/core/svgs/tokens/branded/BNB.svg";
import xrpIcon from "@web3icons/core/svgs/tokens/branded/XRP.svg";
import dogeIcon from "@web3icons/core/svgs/tokens/branded/DOGE.svg";
import adaIcon from "@web3icons/core/svgs/tokens/branded/ADA.svg";
import avaxIcon from "@web3icons/core/svgs/tokens/branded/AVAX.svg";
import linkIcon from "@web3icons/core/svgs/tokens/branded/LINK.svg";
import trxIcon from "@web3icons/core/svgs/tokens/branded/TRX.svg";
import dotIcon from "@web3icons/core/svgs/tokens/branded/DOT.svg";
import ltcIcon from "@web3icons/core/svgs/tokens/branded/LTC.svg";
import bchIcon from "@web3icons/core/svgs/tokens/branded/BCH.svg";
import suiIcon from "@web3icons/core/svgs/tokens/branded/SUI.svg";
import aptIcon from "@web3icons/core/svgs/tokens/branded/APT.svg";
import nearIcon from "@web3icons/core/svgs/tokens/branded/NEAR.svg";
import arbIcon from "@web3icons/core/svgs/tokens/branded/ARB.svg";
import opIcon from "@web3icons/core/svgs/tokens/branded/OP.svg";
import uniIcon from "@web3icons/core/svgs/tokens/branded/UNI.svg";

const tonIcon = `data:image/svg+xml,${encodeURIComponent('<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#0098EA" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0ZM7.902 6.697h8.196c1.505 0 2.462 1.628 1.705 2.94l-5.059 8.765a.86.86 0 0 1-1.488 0L6.199 9.637c-.758-1.314.197-2.94 1.703-2.94Zm4.844 1.496v7.58l1.102-2.128 2.656-4.756a.465.465 0 0 0-.408-.696h-3.35Zm-.002 0H7.9a.464.464 0 0 0-.408.694l2.658 4.754 1.102 2.13V8.195Z"/></svg>')}`;

type CoinIconAsset = string | { src: string };

const coinIconMap: Record<string, CoinIconAsset> = {
  BTC: btcIcon, ETH: ethIcon, SOL: solIcon, BNB: bnbIcon, XRP: xrpIcon,
  DOGE: dogeIcon, ADA: adaIcon, AVAX: avaxIcon, LINK: linkIcon, TRX: trxIcon,
  DOT: dotIcon, LTC: ltcIcon, BCH: bchIcon, TON: tonIcon, SUI: suiIcon,
  APT: aptIcon, NEAR: nearIcon, ARB: arbIcon, OP: opIcon, UNI: uniIcon,
};

export default function CoinIcon({ symbol, className = "" }: { symbol: string; className?: string }) {
  const normalized = symbol.toUpperCase().split("/")[0].replace(/(?:USDT|USD)$/, "");
  const icon = coinIconMap[normalized];
  const rawSource = typeof icon === "string" ? icon : icon?.src;
  const source = rawSource?.trimStart().startsWith("<svg")
    ? `data:image/svg+xml,${encodeURIComponent(rawSource)}`
    : rawSource;
  return <i className={`coin-icon coin-icon-${normalized.toLowerCase()}${className ? ` ${className}` : ""}`} role="img" aria-label={`${normalized} icon`}>
    {source ? <img src={source} alt="" aria-hidden="true" /> : <b>{normalized.slice(0, 1)}</b>}
  </i>;
}
