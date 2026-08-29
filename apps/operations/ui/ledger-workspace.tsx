"use client";

import { useMemo, useState } from "react";

import { formatDateTime, formatDecimal, type OperationsLedgerTransaction } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

export function LedgerWorkspace() {
  const { locale, t } = useAppLocale();
  const [type, setType] = useState("");
  const [currency, setCurrency] = useState("");
  const [cursor, setCursor] = useState("");
  const url = useMemo(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (type) params.set("type", type);
    if (currency) params.set("currency", currency);
    if (cursor) params.set("cursor", cursor);
    return `/api/operations/ledger?${params}`;
  }, [currency, cursor, type]);
  const resource = useApiData<{ transactions: OperationsLedgerTransaction[]; nextCursor: string | null }>(url, t("账本读取失败"));
  return <>
    <PageHeading eyebrow="IMMUTABLE LEDGER" title={t("账本查询")} description={t("只读查看双式账本交易与分录；此工作区没有编辑或删除能力。")} />
    <div className="rc-callout">{t("账本是不可变记录。任何纠正都必须生成新的反向或纠正事务，页面不会提供修改、删除入口。")}</div>
    <section className="rc-panel">
      <header><div><small>{t("游标分页")}</small><h2>{t("账本事务")}</h2></div><div className="rc-filter-row"><label><span>{t("类型")}</span><select value={type} onChange={(event) => { setType(event.target.value); setCursor(""); }}><option value="">{t("全部")}</option><option>deposit_credit</option><option>membership_purchase</option><option>ai_credit_purchase</option><option>freeze</option><option>unfreeze</option><option>return_reserve</option><option>return_confirmed</option><option>correction</option></select></label><label><span>{t("币种")}</span><input value={currency} onChange={(event) => { setCurrency(event.target.value.toUpperCase()); setCursor(""); }} placeholder="USDT" /></label></div></header>
      {resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorState message={resource.error} retry={resource.refresh} /> : !resource.data?.transactions.length ? <EmptyState title={t("没有账本事务")} description={t("当前筛选或数据范围内没有记录。")} /> : <div className="rc-ledger-list">{resource.data.transactions.map((transaction) => <details key={transaction.id}><summary><span><b>{transaction.type}</b><small>{transaction.sourceType} · {transaction.sourceId}</small></span><span><StatusBadge value={transaction.status} /><small>{formatDateTime(transaction.createdAt, locale)}</small></span></summary><div className="rc-table-wrap"><table><thead><tr><th>{t("账户类型")}</th><th>{t("方向")}</th><th>{t("金额")}</th><th>{t("所有者")}</th></tr></thead><tbody>{transaction.postings.map((posting) => <tr key={posting.id}><td>{posting.accountType}<small>{posting.accountId}</small></td><td className={posting.side === "credit" ? "rc-positive" : "rc-negative"}>{posting.side}</td><td>{formatDecimal(posting.amount)} {posting.currency}</td><td><small>{posting.ownerUserId || posting.ownerOrganizationId || t("平台账户")}</small></td></tr>)}</tbody></table></div></details>)}</div>}
      {resource.data?.nextCursor && <div className="rc-pagination"><button className="rc-button" type="button" onClick={() => setCursor(resource.data?.nextCursor ?? "")}>{t("下一页")}</button></div>}
    </section>
  </>;
}
