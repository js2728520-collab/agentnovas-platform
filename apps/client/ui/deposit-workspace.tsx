"use client";

import { useMemo, useState } from "react";

import {
  apiErrorMessage, formatDateTime, formatDecimal,
  type DepositOrder, type EffectiveAccessPayload,
} from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";
import { useApiData } from "@/packages/ui/src/use-api-data";
import { depositFundsLabel, depositOrderLabel, depositRiskLabel } from "./client-account-presentation";

function requestKey() {
  return `deposit-${Date.now()}-${crypto.randomUUID()}`;
}

export function DepositWorkspace({ access }: { access: EffectiveAccessPayload }) {
  const { locale, t } = useAppLocale();
  const orders = useApiData<{ orders: DepositOrder[] }>("/api/wallet/deposit-orders", t("充值订单读取失败"));
  const [network, setNetwork] = useState("TRC20");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canCreate = Boolean(access.permissions["client.deposit.create"]);
  const active = useMemo(() => orders.data?.orders.find((order) =>
    ["PENDING_CONFIRMATION", "CONFIRMING", "MANUAL_REVIEW"].includes(order.orderStatus)), [orders.data]);

  async function createOrder(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/wallet/deposit-orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey() },
        body: JSON.stringify({ network, amount }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, t("充值订单创建失败")));
      setAmount("");
      setMessage(t("专属充值地址已生成。链上确认和入账复核完成后，余额会自动更新。"));
      await orders.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("充值订单创建失败"));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading
      eyebrow={t("账户余额")}
      title={t("充值")}
      description={t("创建一次性充值订单，并按订单指定的网络和地址转入 USDT。")}
      actions={<button className="rc-button" type="button" onClick={() => void orders.refresh()} disabled={orders.loading}>{t("刷新")}</button>}
    />
    {/* UDUN provider boundary remains server-owned; the Client only displays approved customer fields. */}
    <div className="rc-callout rc-callout-warning" role="alert">
      <strong>{t("充值余额只能用于购买本平台服务，不能提现、转出或退款。")}</strong>
      {t("链上转账不可撤回，请核对网络和地址并先小额验证。")}
    </div>
    {canCreate && <section className="rc-panel" aria-labelledby="deposit-create-title">
      <header><div><h2 id="deposit-create-title">{t("创建充值订单")}</h2><p>{t("每个订单只对应一个网络和专属地址。")}</p></div><StatusBadge value={t("复核后入账")} /></header>
      <form className="rc-filter-row" onSubmit={createOrder}>
        <label><span>{t("网络")}</span><select value={network} onChange={(event) => setNetwork(event.target.value)} disabled={busy}><option value="TRC20">TRC20</option><option value="ERC20">ERC20</option><option value="BEP20">BEP20</option></select></label>
        <label><span>{t("预计金额（USDT）")}</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("最低 1 USDT")} required disabled={busy} /></label>
        <button className="rc-button rc-button-primary" type="submit" disabled={busy}>{busy ? t("正在生成…") : t("生成专属地址")}</button>
      </form>
    </section>}
    {active && <section className="rc-panel" aria-labelledby="active-deposit-title">
      <header><div><small>{active.network}</small><h2 id="active-deposit-title">{t("进行中的充值")}</h2></div><StatusBadge value={t(depositOrderLabel(active.orderStatus))} /></header>
      <dl className="rc-detail-grid">
        <div><dt>{t("订单号")}</dt><dd>{active.platformOrderNo}</dd></div>
        <div><dt>{t("预计金额")}</dt><dd>{formatDecimal(active.expectedAmount, 6, locale)} {active.currency}</dd></div>
        <div><dt>{t("专属地址")}</dt><dd className="rc-break-all">{active.depositAddress || t("正在生成")}</dd></div>
        <div><dt>{t("链上交易")}</dt><dd className="rc-break-all">{active.txId || t("等待链上确认")}</dd></div>
        <div><dt>{t("链上确认")}</dt><dd>{active.confirmations}/{active.requiredConfirmations ?? "—"}</dd></div>
        <div><dt>{t("余额状态")}</dt><dd>{t(depositFundsLabel(active.fundsStatus))} · {t(depositRiskLabel(active.riskStatus))}</dd></div>
      </dl>
    </section>}
    <section className="rc-panel" aria-labelledby="deposit-history-title">
      <header><div><h2 id="deposit-history-title">{t("充值记录")}</h2></div></header>
      {orders.loading && !orders.data ? <LoadingState label={t("正在读取充值订单…")} />
        : orders.error && !orders.data ? <ErrorState message={orders.error} retry={orders.refresh} />
          : !orders.data?.orders.length ? <EmptyState title={t("暂无充值订单")} description={t("创建后会在此显示专属地址、链上交易与入账状态。")} />
            : <div className="rc-table-wrap"><table><thead><tr><th>{t("订单")}</th><th>{t("网络/地址")}</th><th>{t("金额")}</th><th>{t("状态")}</th><th>{t("时间")}</th></tr></thead><tbody>{orders.data.orders.map((order) => <tr key={order.id}>
              <td><b>{order.platformOrderNo}</b></td>
              <td><b>{order.network ?? "—"}</b><small className="rc-break-all">{order.depositAddress ?? t("未生成")}</small></td>
              <td><b>{formatDecimal(order.actualAmount ?? order.expectedAmount, 6, locale)} {order.currency}</b><small>{t("已入账")} {formatDecimal(order.creditedAmount, 6, locale)}</small></td>
              <td><StatusBadge value={t(depositOrderLabel(order.orderStatus))} /><small>{t(depositFundsLabel(order.fundsStatus))} · {t(depositRiskLabel(order.riskStatus))}</small></td>
              <td>{formatDateTime(order.createdAt, locale)}</td>
            </tr>)}</tbody></table></div>}
    </section>
    <div className="rc-live" aria-live="polite">{message}</div>
  </>;
}
