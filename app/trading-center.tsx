"use client";

import { useEffect, useMemo, useState } from "react";
import ExchangeLogo, { getExchangeDisplayName } from "./exchange-logo";

type TradingCenterProps = { go: (page: "connect" | "strategies") => void };
type Row = Record<string, unknown>;

const exchanges = [
  ["OKX", "现货与合约"], ["BINANCE", "现货与合约"], ["BYBIT", "现货与永续"], ["BITGET", "现货与合约"],
  ["GATE.IO", "现货与合约"], ["KUCOIN", "现货与合约"], ["COINBASE", "现货交易"], ["KRAKEN", "现货交易"],
  ["CRYPTO.COM", "现货交易"], ["METAMASK", "钱包连接"], ["ROBINHOOD", "现货交易"], ["HTX", "现货交易"],
] as const;

function money(value: unknown) {
  const amount = Number(value) || 0;
  return `${amount > 0 ? "+" : amount < 0 ? "-" : ""}$${Math.abs(amount).toFixed(2)}`;
}

export default function TradingCenter({ go }: TradingCenterProps) {
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [orders, setOrders] = useState<Row[]>([]);
  const [portfolio, setPortfolio] = useState<Row | null>(null);
  const [symbol, setSymbol] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    const [accountResponse, portfolioResponse] = await Promise.all([
      fetch("/api/exchange-accounts", { cache: "no-store" }),
      fetch("/api/portfolio", { cache: "no-store" }),
    ]);
    if (accountResponse.ok) setAccounts(((await accountResponse.json()).accounts || []) as Row[]);
    setOrders([]);
    if (portfolioResponse.ok) setPortfolio(await portfolioResponse.json() as Row);
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), 15_000);
    return () => { window.clearTimeout(initialLoad); clearInterval(timer); };
  }, []);

  const summary = portfolio?.summary || {};
  const positions = (portfolio?.positions || []) as Row[];
  const followed = (portfolio?.strategyPerformance || []) as Row[];
  const filteredOrders = useMemo(() => orders.filter((order) => {
    const matchesSymbol = !symbol.trim() || String(order.symbol || "").toLowerCase().includes(symbol.trim().toLowerCase());
    const date = String(order.closedAt || order.openedAt || order.createdAt || "").slice(0, 10);
    return matchesSymbol && (!from || date >= from) && (!to || date <= to);
  }), [orders, symbol, from, to]);

  async function stopFollowing(subscriptionId: string, source: unknown) {
    setMessage("");
    const path = source === "platform" ? `/api/platform-strategy-subscriptions/${subscriptionId}` : `/api/strategy-subscriptions/${subscriptionId}`;
    const response = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
    const data = await response.json() as { error?: string; message?: string };
    setMessage(data.error || data.message || "操作完成");
    if (response.ok) void load();
  }

  return <>
    <div className="page-head"><div><h1>交易中心</h1><p>我的持仓、完整交易历史、交易所绑定与跟单控制</p></div><div><button className="primary" onClick={() => go("connect")}>交易所钱包API绑定</button></div></div>
    <div className="trading-center-v2">
      <section className="trading-overview"><div><small>TRADING CONTROL CENTER</small><h2>账户状态与交易能力</h2><p>账户权限和连接状态来自当前接口，页面每 15 秒刷新。实盘订单路由未开放，不会因保存凭证自动下单。</p></div><div className="trading-kpis"><div className="kpi"><small>已连接账户</small><b>{accounts.length}</b><span>实时同步</span></div><div className="kpi"><small>当前持仓</small><b>{positions.length}</b><span>实盘数据</span></div><div className="kpi"><small>实盘订单</small><b>{orders.length}</b><span>路由未启用</span></div><div className="kpi"><small>已实现盈亏</small><b className={Number(summary.realizedPnlUsdt) < 0 ? "negative" : "positive"}>{money(summary.realizedPnlUsdt)}</b><span>真实接口数据</span></div></div></section>
      <section className="my-positions-panel"><header className="trading-section-head"><div><small>MY POSITIONS</small><h2>我的持仓</h2></div><span>{positions.length ? `${positions.length} 个未平仓` : "暂无持仓"}</span></header>{positions.length ? <div className="table-wrap"><table><thead><tr><th>产品</th><th>方向</th><th>数量</th><th>开仓价值</th><th>开仓时间</th><th>来源</th></tr></thead><tbody>{positions.map(position => <tr key={String(position.id)}><td><b>{String(position.symbol)}</b></td><td className={position.side === "sell" ? "down" : "up"}>{position.side === "sell" ? "卖出" : "买入"}</td><td>{String(position.quantity)}</td><td>${Number(position.entryValueUsdt || 0).toFixed(2)}</td><td>{String(position.openedAt || "—")}</td><td>{position.origin === "platform" ? "策略跟单" : "客户操作"}</td></tr>)}</tbody></table></div> : <div className="trading-empty compact-empty"><i>◇</i><b>暂无实盘持仓</b><span>实盘订单路由尚未开放，当前不显示模拟测试仓位。</span></div>}</section>
      <section className="followed-performance"><header className="trading-section-head"><div><small>FOLLOWING STRATEGIES</small><h2>我的跟单</h2></div><button className="soft" onClick={() => go("strategies")}>浏览策略</button></header>{followed.length ? <div className="followed-strategy-grid">{followed.map(strategy => <article key={String(strategy.subscriptionId || strategy.id)}><header><div><span className="strategy-source">{strategy.source === "platform" ? "平台策略" : "策略广场"}</span><em>{strategy.status === "active" ? "运行中" : strategy.status === "paused" ? "已暂停" : "已结束"}</em></div><div className="strategy-pnl"><small>累计盈亏</small><b className={Number(strategy.realizedPnlUsdt) < 0 ? "negative" : "positive"}>{money(strategy.realizedPnlUsdt)}</b></div></header><h3>{String(strategy.name || "未命名策略")}</h3><p>{Array.isArray(strategy.symbols) && strategy.symbols.length ? strategy.symbols.join(" · ") : strategy.source === "platform" ? "等待首轮真实行情决策" : "等待策略交易"}</p><dl><div><dt>收益率</dt><dd>{Number(strategy.returnPct || 0).toFixed(2)}%</dd></div><div><dt>最大回撤</dt><dd>{Number(strategy.maxDrawdownPct || 0).toFixed(2)}%</dd></div><div><dt>当前持仓</dt><dd>{Number(strategy.openPositions || 0)} 笔</dd></div></dl>{strategy.subscriptionId && strategy.status !== "ended" && <button className="danger prominent-stop" onClick={() => void stopFollowing(String(strategy.subscriptionId), strategy.source)}>停止跟单</button>}</article>)}</div> : <div className="trading-empty compact-empty"><i>◇</i><b>暂无跟单策略</b><span>跟随策略后，运行状态、收益和停止跟单入口会显示在这里。</span></div>}</section>
      <section className="order-history-panel"><header className="trading-section-head"><div><small>COMPLETE ORDER HISTORY</small><h2>完整交易历史</h2></div><span>{filteredOrders.length} 条匹配</span></header><form className="history-filters" onSubmit={event => event.preventDefault()}><input value={symbol} onChange={event => setSymbol(event.target.value)} placeholder="按产品 / Symbol 搜索"/><label>开始日期<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>结束日期<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label><button type="button" className="soft" onClick={() => { setSymbol(""); setFrom(""); setTo(""); }}>清除筛选</button></form>{filteredOrders.length ? <div className="table-wrap"><table><thead><tr><th>产品</th><th>方向</th><th>数量</th><th>状态</th><th>开仓</th><th>平仓</th><th>已实现盈亏</th><th>来源</th></tr></thead><tbody>{filteredOrders.map(order => <tr key={String(order.id)}><td><b>{String(order.symbol)}</b></td><td>{order.side === "sell" ? "卖出" : "买入"}</td><td>{String(order.quantity)}</td><td>{String(order.status || "—")}</td><td>{String(order.openedAt || "—")}</td><td>{String(order.closedAt || "未平仓")}</td><td className={Number(order.realizedNetPnlUsdt || 0) < 0 ? "negative" : "positive"}>{money(order.realizedNetPnlUsdt)}</td><td>{order.origin === "platform" ? "策略跟单" : "客户操作"}</td></tr>)}</tbody></table></div> : <div className="trading-empty compact-empty"><i>↕</i><b>没有符合条件的记录</b><span>调整产品或日期筛选条件后重试。</span></div>}</section>
      <section className="trading-connections-v2"><header className="trading-section-head"><div><small>EXCHANGE CONNECTIONS</small><h2>交易所连接</h2></div><span>12 个连接入口</span></header><div className="trading-exchange-grid">{exchanges.map(([name, description]) => { const account = accounts.find(item => item.exchange === name); return <button className="trading-exchange" key={name} onClick={() => go("connect")}><ExchangeLogo name={name} /><span><b>{getExchangeDisplayName(name)}</b><small>{account ? `已绑定 · ${account.status}` : description}</small></span><em className={account?.status === "active" ? "ok" : ""}>{account?.status === "active" ? "已启用" : account ? "待检测" : "连接"}</em></button>; })}</div><p className="trading-disclosure">连接仅用于保存凭证和检测权限；实盘订单路由尚未开放，保存凭证不会发送订单。客户策略模拟测试在“我的策略”中独立进行。</p></section>
      {message && <p className="admin-notice">{message}</p>}
    </div>
  </>;
}
