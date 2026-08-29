"use client";

import { useCallback, useEffect, useState } from "react";

import { formatDateTime, formatDecimal, type LedgerEntry, type WalletBalance } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import { clientErrorMessage, clientRequest } from "./client-api";
import { ledgerEntryLabel } from "./client-account-presentation";

export function WalletWorkspace() {
  const { locale, t } = useAppLocale();
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setState("loading"); setError("");
    try {
      const [balancePayload, ledgerPayload] = await Promise.all([
        clientRequest<{ balances?: WalletBalance[] }>("/api/wallet/balances", {}, t("钱包余额读取失败")),
        clientRequest<{ entries?: LedgerEntry[] }>("/api/wallet/ledger?limit=100", {}, t("账本流水读取失败")),
      ]);
      setBalances(Array.isArray(balancePayload.balances) ? balancePayload.balances : []);
      setEntries(Array.isArray(ledgerPayload.entries) ? ledgerPayload.entries : []);
      setState("ready");
    } catch (caught) { setError(clientErrorMessage(caught, t("钱包读取失败"))); setState("error"); }
  }, [t]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  return <>
    <PageHeading eyebrow={t("账户余额")} title={t("钱包")} description={t("查看可用于会员与绩效服务费支付的账户余额和收支记录。余额不能提现、转出或退款。")} actions={<button className="rc-button" type="button" onClick={() => void load()} disabled={state === "loading"}>{t("刷新")}</button>} />
    {state === "loading" ? <LoadingState /> : state === "error" ? <ErrorState message={error} retry={() => void load()} /> : <>
      <section className="rc-kpi-grid" aria-label={t("钱包余额")}>
        {balances.length ? balances.map((balance) => <article key={balance.currency}><small>{balance.currency} {t("可用余额")}</small><strong>{formatDecimal(balance.availableAmount, 6, locale)} {balance.currency}</strong><span>{t("暂不可用")} {formatDecimal(balance.frozenAmount, 6, locale)} {balance.currency}</span></article>) : <article><small>USDT {t("可用余额")}</small><strong>0 USDT</strong><span>{t("尚无账户余额")}</span></article>}
      </section>
      <section className="rc-panel"><header><div><h2>{t("收支记录")}</h2></div><StatusBadge value={`${entries.length} ${t("条")}`} /></header>
        {!entries.length ? <EmptyState title={t("暂无收支记录")} description={t("充值入账或购买服务后，记录会显示在这里。")} /> : <div className="rc-table-wrap"><table><thead><tr><th>{t("时间")}</th><th>{t("说明")}</th><th>{t("金额")}</th></tr></thead><tbody>{entries.map((entry) => {
          const presentation = ledgerEntryLabel(entry.type);
          return <tr key={entry.id}><td>{formatDateTime(entry.createdAt, locale)}</td><td><b>{t(presentation.title)}</b><small>{t(presentation.detail)}</small></td><td className={Number(entry.amount) >= 0 ? "rc-positive" : "rc-negative"}>{Number(entry.amount) >= 0 ? "+" : ""}{formatDecimal(entry.amount, 6, locale)} {entry.currency}</td></tr>;
        })}</tbody></table></div>}
      </section>
    </>}
  </>;
}
