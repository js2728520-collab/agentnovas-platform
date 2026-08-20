"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiErrorMessage, formatDateTime, formatDecimal, type EffectiveAccessPayload, type LedgerEntry, type ViewerPayload, type WalletBalance } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";

import { ClientPortalShell } from "./client-portal-shell";

export function WalletWorkspace({ viewer, access }: { viewer: ViewerPayload; access: EffectiveAccessPayload }) {
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setState("loading"); setError("");
    try {
      const [balanceResponse, ledgerResponse] = await Promise.all([
        fetch("/api/wallet/balances", { cache: "no-store" }),
        fetch("/api/wallet/ledger?limit=100", { cache: "no-store" }),
      ]);
      const [balancePayload, ledgerPayload] = await Promise.all([balanceResponse.json().catch(() => ({})), ledgerResponse.json().catch(() => ({}))]);
      if (!balanceResponse.ok) throw new Error(apiErrorMessage(balancePayload, "钱包余额读取失败"));
      if (!ledgerResponse.ok) throw new Error(apiErrorMessage(ledgerPayload, "账本流水读取失败"));
      setBalances(Array.isArray(balancePayload.balances) ? balancePayload.balances : []);
      setEntries(Array.isArray(ledgerPayload.entries) ? ledgerPayload.entries : []);
      setState("ready");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "钱包读取失败"); setState("error"); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  return <ClientPortalShell viewer={viewer} access={access}>
    <PageHeading eyebrow="CLIENT WALLET" title="钱包与账本" description="预付 USDT 仅用于会员和 AI 积分；账本流水不可编辑或删除。" actions={<Link className="rc-button" href="/wallet/deposits">创建充值订单</Link>} />
    {state === "loading" ? <LoadingState /> : state === "error" ? <ErrorState message={error} retry={() => void load()} /> : <>
      <section className="rc-kpi-grid" aria-label="钱包余额">
        {balances.length ? balances.map((balance) => <article key={balance.currency}><small>{balance.currency} 可用余额</small><strong>{formatDecimal(balance.availableAmount)}</strong><span>冻结 {formatDecimal(balance.frozenAmount)} · 版本 {balance.version}</span></article>) : <article><small>USDT 可用余额</small><strong>0</strong><span>尚无账本余额</span></article>}
      </section>
      <section className="rc-panel"><header><div><small>IMMUTABLE LEDGER</small><h2>账本流水</h2></div><StatusBadge value={`${entries.length} 条`} /></header>
        {!entries.length ? <EmptyState title="暂无账本流水" description="充值入账或会员消费后，交易会以不可变分录显示在这里。" /> : <div className="rc-table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>来源</th><th>币种</th><th>金额</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{formatDateTime(entry.createdAt)}</td><td>{entry.type}</td><td><b>{entry.sourceType}</b><small>{entry.sourceId}</small></td><td>{entry.currency}</td><td className={Number(entry.amount) >= 0 ? "rc-positive" : "rc-negative"}>{Number(entry.amount) >= 0 ? "+" : ""}{formatDecimal(entry.amount)}</td></tr>)}</tbody></table></div>}
      </section>
    </>}
  </ClientPortalShell>;
}
