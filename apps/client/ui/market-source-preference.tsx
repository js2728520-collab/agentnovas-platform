"use client";

import { useCallback, useEffect, useState } from "react";

import { clientErrorMessage, clientRequest } from "./client-api";
import styles from "./market-source-preference.module.css";

type Selection = { mode: "account_aligned"; accountId: string } | { mode: "independent"; providerId: string };
type Origin = "customer_preference" | "platform_default";
type MarketRow = {
  marketId: string;
  assetClass: string;
  selectableProviderIds: string[];
  selection: Selection | null;
  origin: Origin;
  updatedAt: string | null;
};
type OfficialCards = { strategyCodes: string[]; providerId: string; followsPreference: boolean; reason: string };

const marketNames: Record<string, string> = {
  "crypto-global": "加密货币",
  "equities-us": "美股",
  "equities-au": "澳股",
  "equities-cn": "A 股",
  "equities-hk": "港股",
  "equities-jp": "日股",
  "equities-kr": "韩股",
  "forex-global": "外汇",
  "metals-global": "贵金属",
};

const assetClassNames: Record<string, string> = {
  crypto: "CRYPTO", equity: "EQUITY", forex: "FOREX", metal: "METALS",
};

function providerLabel(providerId: string) {
  if (providerId.startsWith("exchange-")) return providerId.slice("exchange-".length).replace(/-/g, " ").toUpperCase();
  if (providerId.startsWith("equity-")) return `${providerId.slice("equity-".length).toUpperCase()} 行情源`;
  return providerId;
}

function selectedProviderId(selection: Selection | null) {
  return selection && selection.mode === "independent" ? selection.providerId : null;
}

export default function MarketSourcePreference() {
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [officialCards, setOfficialCards] = useState<OfficialCards | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [busyKey, setBusyKey] = useState("");

  const load = useCallback(async () => {
    setState("loading"); setMessage("");
    try {
      const payload = await clientRequest<{ markets?: MarketRow[]; officialCards?: OfficialCards }>(
        "/api/market/source-preference", {}, "行情源偏好读取失败",
      );
      setMarkets(Array.isArray(payload.markets) ? payload.markets : []);
      setOfficialCards(payload.officialCards ?? null);
      setState("ready");
    } catch (error) {
      setMessageKind("error");
      setMessage(clientErrorMessage(error, "行情源偏好读取失败"));
      setState("error");
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function choose(marketId: string, providerId: string) {
    const key = `${marketId}:${providerId}`;
    if (busyKey) return;
    setBusyKey(key); setMessage("");
    try {
      await clientRequest<{ ok: boolean }>("/api/market/source-preference", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketId, selection: { mode: "independent", providerId } }),
      }, "行情源偏好保存失败");
      setMarkets((current) => current.map((market) => market.marketId === marketId
        ? { ...market, selection: { mode: "independent", providerId }, origin: "customer_preference", updatedAt: new Date().toISOString() }
        : market));
      setMessageKind("success");
      setMessage("行情源偏好已保存，之后的展示与研发取数按此选择");
    } catch (error) {
      setMessageKind("error");
      // 保存失败时本地状态不动：让界面显示一个没有落库的选择，比报错更糟。
      setMessage(clientErrorMessage(error, "行情源偏好保存失败，原设置保持不变"));
    } finally { setBusyKey(""); }
  }

  return <section className={styles.panel} aria-label="行情源偏好">
    <div className={styles.head}>
      <h3>行情源偏好</h3>
      <p>作用于行情展示与策略研发取数</p>
    </div>

    {officialCards && !officialCards.followsPreference && <div className={styles.officialNotice}>
      <span><b>官方策略卡不跟随此设置。</b>{officialCards.reason}。</span>
      <span>涉及 <code>{officialCards.strategyCodes.join(" / ")}</code>，统一使用 <code>{providerLabel(officialCards.providerId)}</code>。</span>
    </div>}

    {message && <p className={styles.message} data-kind={messageKind} role="status">{message}</p>}

    {state === "loading" && <p className={styles.empty}>正在读取…</p>}
    {state === "ready" && markets.length === 0 && <p className={styles.empty}>当前没有可选的市场。</p>}

    {state === "ready" && <div className={styles.markets}>
      {markets.map((market) => {
        const chosen = selectedProviderId(market.selection);
        return <article className={styles.market} key={market.marketId}>
          <div className={styles.marketHead}>
            <span className={styles.marketName}>
              {marketNames[market.marketId] ?? market.marketId}
              <span className={styles.assetClass}> · {assetClassNames[market.assetClass] ?? market.assetClass}</span>
            </span>
            <span className={styles.origin} data-origin={market.origin}>
              {market.origin === "customer_preference" ? "已选择" : "平台默认"}
            </span>
          </div>
          <div className={styles.sources}>
            {market.selectableProviderIds.map((providerId) => <button
              type="button"
              key={providerId}
              className={styles.source}
              data-selected={providerId === chosen}
              disabled={busyKey !== ""}
              aria-pressed={providerId === chosen}
              onClick={() => void choose(market.marketId, providerId)}
            >{providerLabel(providerId)}</button>)}
          </div>
        </article>;
      })}
    </div>}
  </section>;
}
