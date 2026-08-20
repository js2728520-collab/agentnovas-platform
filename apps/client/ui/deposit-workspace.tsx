"use client";

import { useCallback, useEffect, useState } from "react";

import { apiErrorMessage, formatDateTime, formatDecimal, type DepositOrder, type EffectiveAccessPayload, type ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";

import { ClientPortalShell } from "./client-portal-shell";

export function DepositWorkspace({ viewer, access }: { viewer: ViewerPayload; access: EffectiveAccessPayload }) {
  const [orders, setOrders] = useState<DepositOrder[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/wallet/deposit-orders", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(payload, "充值订单读取失败"));
      setOrders(Array.isArray(payload.orders) ? payload.orders : []); setState("ready");
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "充值订单读取失败"); setState("error"); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function createOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setBusy(true); setMessage("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/wallet/deposit-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const prefix = response.status === 503 ? "充值服务尚未配置：" : "";
        throw new Error(`${prefix}${apiErrorMessage(payload, "订单创建失败")}`);
      }
      setMessage(payload.order?.depositAddress ? `订单已创建，请仅向地址 ${payload.order.depositAddress} 转入指定资产。` : "订单已创建，等待服务端提供充值信息。");
      await load();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "订单创建失败"); }
    finally { setBusy(false); }
  }

  return <ClientPortalShell viewer={viewer} access={access}>
    <PageHeading eyebrow="CLIENT DEPOSITS" title="充值订单" description="充值形成平台预付余额，不支持提现、转账或真实交易。" />
    <section className="rc-split-layout"><form className="rc-panel rc-form" onSubmit={createOrder}><header><div><small>CREATE ORDER</small><h2>创建充值订单</h2></div></header>
      <label>充值渠道<select name="channel" defaultValue="on_chain"><option value="on_chain">链上充值</option><option value="bank_transfer">银行转账</option><option value="manual">人工登记</option></select></label>
      <label>USDT 网络<select name="network" defaultValue="TRC20"><option value="TRC20">TRC20</option><option value="ERC20">ERC20</option><option value="BEP20">BEP20</option></select></label>
      <label>预计金额<input name="amount" type="number" min="0.000001" step="0.000001" required /></label>
      <p>只有服务端存在 active 或 sandbox 服务商配置时才会生成订单；系统不会伪造充值地址。</p>
      <button className="rc-primary" disabled={busy}>{busy ? "正在创建…" : "创建订单"}</button>{message && <div className="rc-callout" role="status" aria-live="polite">{message}</div>}
    </form>
    <section className="rc-panel"><header><div><small>ORDER HISTORY</small><h2>订单记录</h2></div><StatusBadge value={`${orders.length} 笔`} /></header>
      {state === "loading" ? <LoadingState /> : state === "error" ? <ErrorState message={message} retry={() => void load()} /> : !orders.length ? <EmptyState title="暂无充值订单" description="创建订单后可在这里追踪网络确认、资金和风险状态。" /> : <div className="rc-order-list">{orders.map((order) => <article key={order.id}><header><div><b>{order.platformOrderNo}</b><small>{formatDateTime(order.createdAt)}</small></div><StatusBadge value={order.orderStatus} /></header><dl><div><dt>预计/实际</dt><dd>{formatDecimal(order.expectedAmount)} / {formatDecimal(order.actualAmount)} {order.currency}</dd></div><div><dt>渠道/网络</dt><dd>{order.channel} · {order.network || "—"}</dd></div><div><dt>确认数</dt><dd>{order.confirmations}/{order.requiredConfirmations ?? "—"}</dd></div><div><dt>资金/风控</dt><dd><StatusBadge value={order.fundsStatus} /> <StatusBadge value={order.riskStatus} /></dd></div></dl>{order.depositAddress && <code>{order.depositAddress}</code>}{order.txId && <small>交易哈希：{order.txId}</small>}</article>)}</div>}
    </section></section>
  </ClientPortalShell>;
}
