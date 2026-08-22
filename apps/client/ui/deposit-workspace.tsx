"use client";

import { useMemo, useState } from "react";

import {
  apiErrorMessage, formatDateTime, formatDecimal,
  type DepositOrder, type EffectiveAccessPayload,
} from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

function requestKey() {
  return `deposit-${Date.now()}-${crypto.randomUUID()}`;
}

export function DepositWorkspace({ access }: { access: EffectiveAccessPayload }) {
  const orders = useApiData<{ orders: DepositOrder[] }>("/api/wallet/deposit-orders", "充值订单读取失败");
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
      if (!response.ok) throw new Error(apiErrorMessage(payload, "充值订单创建失败"));
      setAmount("");
      setMessage("优盾充值地址已由服务端生成。到账回调验签后仍需运营双人复核，页面不会提前显示到账。");
      await orders.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "充值订单创建失败");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageHeading
      eyebrow="CLIENT DEPOSITS · UDUN"
      title="USDT 充值与订单"
      description="平台通过优盾生成专属充值地址；仅展示服务端真实返回值，回调验签并由运营双人复核后才进入钱包。"
      actions={<button className="rc-button" type="button" onClick={() => void orders.refresh()} disabled={orders.loading}>刷新订单</button>}
    />
    <div className="rc-callout" role="status">
      只可向订单指定的网络和地址转入 USDT。提现、站内划转与自动扣款未开放；链上转账不可撤回，请先小额验证。
    </div>
    {canCreate && <section className="rc-panel" aria-labelledby="deposit-create-title">
      <header><div><small>UDUN DEPOSIT-ONLY</small><h2 id="deposit-create-title">创建充值订单</h2><p>配置不完整或优盾不可用时，系统返回明确原因，不会生成占位地址。</p></div><StatusBadge value="双人复核入账" /></header>
      <form className="rc-filter-row" onSubmit={createOrder}>
        <label><span>网络</span><select value={network} onChange={(event) => setNetwork(event.target.value)} disabled={busy}><option value="TRC20">TRC20</option><option value="ERC20">ERC20</option><option value="BEP20">BEP20</option></select></label>
        <label><span>预计金额（USDT）</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="最低 1 USDT" required disabled={busy} /></label>
        <button className="rc-button rc-button-primary" type="submit" disabled={busy}>{busy ? "正在请求优盾…" : "生成专属地址"}</button>
      </form>
    </section>}
    {active && <section className="rc-panel" aria-labelledby="active-deposit-title">
      <header><div><small>{active.provider ?? "支付服务商"} · {active.network}</small><h2 id="active-deposit-title">进行中的充值</h2></div><StatusBadge value={active.orderStatus} /></header>
      <dl className="rc-detail-grid">
        <div><dt>订单号</dt><dd>{active.platformOrderNo}</dd></div>
        <div><dt>预计金额</dt><dd>{formatDecimal(active.expectedAmount)} {active.currency}</dd></div>
        <div><dt>专属地址</dt><dd className="rc-break-all">{active.depositAddress || "服务商未返回地址"}</dd></div>
        <div><dt>链上交易</dt><dd className="rc-break-all">{active.txId || "等待回调"}</dd></div>
        <div><dt>确认/复核</dt><dd>{active.confirmations}/{active.requiredConfirmations ?? "—"} · {active.riskStatus}</dd></div>
        <div><dt>资金状态</dt><dd>{active.fundsStatus}</dd></div>
      </dl>
    </section>}
    <section className="rc-panel" aria-labelledby="deposit-history-title">
      <header><div><small>IMMUTABLE EVIDENCE</small><h2 id="deposit-history-title">充值历史</h2></div></header>
      {orders.loading && !orders.data ? <LoadingState label="正在读取充值订单…" />
        : orders.error && !orders.data ? <ErrorState message={orders.error} retry={orders.refresh} />
          : !orders.data?.orders.length ? <EmptyState title="暂无充值订单" description="创建后会在此显示优盾地址、链上交易与复核状态。" />
            : <div className="rc-table-wrap"><table><thead><tr><th>订单</th><th>网络/地址</th><th>金额</th><th>状态</th><th>时间</th></tr></thead><tbody>{orders.data.orders.map((order) => <tr key={order.id}>
              <td><b>{order.platformOrderNo}</b><small>{order.provider ?? "—"}</small></td>
              <td><b>{order.network ?? "—"}</b><small className="rc-break-all">{order.depositAddress ?? "未生成"}</small></td>
              <td><b>{formatDecimal(order.actualAmount ?? order.expectedAmount)} {order.currency}</b><small>已入账 {formatDecimal(order.creditedAmount)}</small></td>
              <td><StatusBadge value={order.orderStatus} /><small>{order.fundsStatus} · {order.riskStatus}</small></td>
              <td>{formatDateTime(order.createdAt)}</td>
            </tr>)}</tbody></table></div>}
    </section>
    <div className="rc-live" aria-live="polite">{message}</div>
  </>;
}
