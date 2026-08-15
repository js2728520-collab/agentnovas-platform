"use client";

import { useEffect, useState } from "react";
import SimulatedOrderForm from "./simulated-order-form";

export default function LivePortfolio() {
  const [data, setData] = useState<any>(null);
  const [risk, setRisk] = useState<any>(null);
  const load = () => Promise.all([
    fetch("/api/portfolio").then((response) => response.ok ? response.json() : null),
    fetch("/api/risk/status").then((response) => response.ok ? response.json() : null),
  ]).then(([portfolio, riskStatus]) => {
    setData(portfolio);
    setRisk(riskStatus);
  }).catch(() => {});

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const summary = data?.summary || { realizedPnlUsdt: 0, unrealizedPnlUsdt: 0, openPositions: 0, totalTrades: 0 };
  return <>
    <PageHead title="资产与持仓" sub="实时读取账户状态 · 实盘订单路由尚未开放" actions={<span className="online">● {data ? "后台已同步" : "等待同步"}</span>} />
    <section className="wide-panel risk-live-panel">
      <div className="widget-head"><b>实时硬风控</b><span className={risk?.allowed ? "green" : "down"}>{risk?.allowed ? "检查通过" : "暂不可用"}</span></div>
      <div className="risk-summary">{risk?.summary ? `当前仓位 $${Number(risk.summary.positionValue || 0).toFixed(2)} · 今日已实现 $${Number(risk.summary.todayPnl || 0).toFixed(2)}` : "正在读取风险数据"}<time>{risk?.updatedAt ? new Date(risk.updatedAt).toLocaleTimeString() : "—"}</time></div>
      <div className="risk-check-grid">{(risk?.checks || []).map((check: any) => <span key={check.key} className={check.ok ? "ok" : "blocked"}><i>{check.ok ? "✓" : "!"}</i>{check.label}</span>)}</div>
    </section>
    <SimulatedOrderForm accounts={data?.accounts || []} allowed={Boolean(risk?.allowed)} onDone={() => void load()} />
    <div className="kpis">
      <Kpi n="已实现收益" v={`${summary.realizedPnlUsdt >= 0 ? "+" : ""}$${Number(summary.realizedPnlUsdt).toFixed(2)}`} s="实盘成交归因" />
      <Kpi n="未实现收益" v={`${summary.unrealizedPnlUsdt >= 0 ? "+" : ""}$${Number(summary.unrealizedPnlUsdt).toFixed(2)}`} s="当前实盘持仓" />
      <Kpi n="未平仓数量" v={String(summary.openPositions)} s="实时同步" />
      <Kpi n="订单总数" v={String(summary.totalTrades)} s="实盘订单" />
    </div>
    <section className="wide-panel">
      <div className="widget-head"><b>已连接账户</b><span>{(data?.accounts || []).length} 个</span></div>
      {data?.accounts?.length ? data.accounts.map((account: any) => <div className="service" key={account.id}><span><i />{account.exchange} · {account.label}</span><b>{account.status === "active" ? "权限已检测" : "待检测"}</b><small>{account.status === "active" ? "可读取" : "只读/待检测"}</small></div>) : <p>暂无已连接账户，请先在“连接交易所”完成权限检测。</p>}
    </section>
    <section className="wide-panel">
      <div className="widget-head"><b>当前实盘持仓</b><span>仅显示真实执行记录</span></div>
      {data?.positions?.length ? <div className="table-wrap"><table><thead><tr><th>交易对</th><th>方向</th><th>数量</th><th>开仓价值</th><th>来源</th></tr></thead><tbody>{data.positions.map((position: any) => <tr key={position.id}><td>{position.symbol}</td><td>{position.side}</td><td>{position.quantity}</td><td>${Number(position.entryValueUsdt).toFixed(2)}</td><td>{position.origin === "platform" ? "平台策略" : "客户手动"}</td></tr>)}</tbody></table></div> : <p>当前没有真实未平仓持仓。实盘路由尚未开放，模拟测试仓位不会显示在这里。</p>}
    </section>
    <PortfolioStrategies />
  </>;
}
