"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CursorPage, PaperPortfolio, PaperTrade } from "@/packages/contracts/src/commercial-beta";
import { tradingHallAgentCatalog, type TradingHallDecisionEvent, type TradingHallPayload } from "@/packages/contracts/src/trading-hall";
import { clientErrorMessage, clientRequest } from "./client-api";
import styles from "./trading-experience.module.css";

type TradingData = { hall: TradingHallPayload; portfolios: PaperPortfolio[]; trades: PaperTrade[]; nextCursor: string | null };
const strategyLabels = { ai_conservative: "AI 稳健型", ai_balanced: "AI 平衡型", ai_aggressive: "AI 激进型" } as const;
const statusLabels = { ACTIVE: "运行中", CLOSE_ONLY: "仅平仓", READ_ONLY: "只读" } as const;
function time(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—"; }
function pnlClass(value: string) { return value.startsWith("-") ? styles.negative : styles.positive; }
function eventFor(events: TradingHallDecisionEvent[], role: string) { return events.find((event) => event.role === role); }

export default function TradingExperience({ go, portfolioId }: { go?: unknown; portfolioId?: string }) {
  void go;
  const [data, setData] = useState<TradingData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [roundId, setRoundId] = useState("");
  const load = useCallback(async () => {
    setState("loading"); setMessage("");
    try {
      const [hall, portfolioPage, tradePage] = await Promise.all([
        clientRequest<TradingHallPayload>("/api/trading-hall", {}, "七阶段决策记录读取失败"),
        clientRequest<{ data: PaperPortfolio[] }>("/api/trading-hall/paper/portfolio", {}, "官方三卡组合读取失败"),
        clientRequest<CursorPage<PaperTrade>>("/api/trading-hall/paper/trades?limit=50", {}, "模拟成交记录读取失败"),
      ]);
      setData({ hall, portfolios: portfolioPage.data, trades: tradePage.data, nextCursor: tradePage.page.nextCursor });
      setRoundId((current) => current || hall.decisionRounds[0]?.decisionRoundId || ""); setState("ready");
    } catch (error) { setMessage(clientErrorMessage(error, "交易中心读取失败")); setState("error"); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function loadMore() {
    if (!data?.nextCursor || busy) return;
    setBusy(true); setMessage("");
    try {
      const page = await clientRequest<CursorPage<PaperTrade>>(`/api/trading-hall/paper/trades?limit=50&cursor=${encodeURIComponent(data.nextCursor)}`, {}, "更多模拟成交读取失败");
      setData((current) => current ? { ...current, trades: [...current.trades, ...page.data], nextCursor: page.page.nextCursor } : current);
    } catch (error) { setMessage(clientErrorMessage(error, "更多模拟成交读取失败")); }
    finally { setBusy(false); }
  }
  const selectedRound = useMemo(() => data?.hall.decisionRounds.find((round) => round.decisionRoundId === roundId) ?? data?.hall.decisionRounds[0] ?? null, [data, roundId]);

  if (state === "loading") return <div className={styles.root} aria-busy="true" aria-label="交易中心加载中"><div className={styles.skeleton} /><div className={styles.skeleton} /></div>;
  if (state === "error" || !data) return <div className={styles.root}><section className={styles.panel}><h1>交易中心暂不可用</h1><p className={styles.error} role="alert">{message}</p><button className={styles.button} type="button" onClick={() => void load()}>重试</button></section></div>;

  const visiblePortfolios = portfolioId ? data.portfolios.filter((portfolio) => portfolio.id === portfolioId) : data.portfolios;
  const visibleTrades = portfolioId ? data.trades.filter((trade) => trade.portfolioId === portfolioId) : data.trades;
  return <div className={styles.root}>
    <header className={styles.hero}><div><span className={styles.eyebrow}>OFFICIAL PAPER · SPOT USDT</span><h1>交易中心</h1><p>查看官方三卡独立模拟资金、现货持仓、成交历史和七阶段决策证据。真实订单路由保持关闭。</p></div><div className={styles.actions}><span className={styles.badge}>{data.hall.productBoundary.currentExecutionMode}</span><button className={styles.button} type="button" onClick={() => void load()}>刷新证据</button></div></header>
    <section className={styles.boundary} aria-label="产品执行边界"><div><span>市场</span><b>{data.hall.productBoundary.targetMarket}</b></div><div><span>资产</span><b>{data.hall.productBoundary.symbols.join(" · ")}</b></div><div><span>杠杆 / 做空</span><b>关闭 / 关闭</b></div><div><span>真实订单</span><b>{data.hall.productBoundary.realOrderRoutingEnabled ? "已开启" : "关闭"}</b></div></section>
    <section className={styles.panel} aria-labelledby="paper-portfolios-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>THREE INDEPENDENT PORTFOLIOS</span><h2 id="paper-portfolios-title">{portfolioId ? "模拟组合详情" : "官方三卡模拟组合"}</h2></div><span className={styles.badge}>{visiblePortfolios.length} / {portfolioId ? 1 : 3}</span></div>{!portfolioId && data.portfolios.length !== 3 && <p className={styles.error} role="alert">官方三卡组合不完整，当前数据仅供核对；请勿据此判断完整组合表现。</p>}{portfolioId && visiblePortfolios.length === 0 && <p className={styles.error} role="alert">未找到当前账号所属的模拟组合，或该组合已不可见。</p>}{visiblePortfolios.length === 0 && !portfolioId ? <p className={styles.empty}>当前会员尚无官方模拟组合。组合仅由服务端在会员激活后初始化。</p> : <div className={styles.cards}>{visiblePortfolios.map((portfolio) => <article className={styles.card} key={portfolio.id}><header><div><span className={styles.eyebrow}>{portfolio.strategyCode}</span><h3>{strategyLabels[portfolio.strategyCode]}</h3></div><span className={styles.badge}>{statusLabels[portfolio.status]}</span></header><p>每张卡本金固定为 {portfolio.initialCashUsdt} USDT；不可从 Client 修改。</p><div className={styles.metrics}><div className={styles.metric}><span>权益</span><b>{portfolio.equityUsdt} USDT</b></div><div className={styles.metric}><span>现金</span><b>{portfolio.cashUsdt} USDT</b></div><div className={styles.metric}><span>已实现净收益</span><b className={pnlClass(portfolio.realizedNetPnlUsdt)}>{portfolio.realizedNetPnlUsdt}</b></div><div className={styles.metric}><span>未实现收益</span><b className={pnlClass(portfolio.unrealizedPnlUsdt)}>{portfolio.unrealizedPnlUsdt}</b></div></div><div className={styles.positions}>{portfolio.positions.length === 0 ? <span className={styles.muted}>暂无现货持仓</span> : portfolio.positions.map((position) => <div className={styles.position} key={position.id}><b>{position.symbol}</b><span>{position.quantity}</span><span>成本 {position.averageEntryPrice}</span><span className={pnlClass(position.unrealizedPnlUsdt)}>浮盈亏 {position.unrealizedPnlUsdt}</span></div>)}</div></article>)}</div>}</section>
    <section className={styles.panel} aria-labelledby="paper-trades-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>IMMUTABLE PAPER FILLS</span><h2 id="paper-trades-title">模拟成交历史</h2></div><span className={styles.badge}>{visibleTrades.length} 条</span></div>{visibleTrades.length === 0 ? <p className={styles.empty}>暂无模拟成交。这里不会生成占位订单或示例收益。</p> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>成交时间</th><th>策略</th><th>现货资产</th><th>方向</th><th>数量</th><th>成交价</th><th>手续费</th><th>已实现净收益</th><th>决策轮</th></tr></thead><tbody>{visibleTrades.map((trade) => <tr key={trade.id}><td>{time(trade.filledAt)}</td><td>{strategyLabels[trade.strategyCode]}</td><td>{trade.symbol}</td><td>{trade.side}</td><td>{trade.quantity}</td><td>{trade.priceUsdt}</td><td>{trade.feeUsdt}</td><td className={pnlClass(trade.realizedNetPnlUsdt)}>{trade.realizedNetPnlUsdt}</td><td>{trade.decisionRoundId}</td></tr>)}</tbody></table></div>}{data.nextCursor && <button className={styles.button} type="button" disabled={busy} onClick={() => void loadMore()}>{busy ? "正在读取…" : "加载更多"}</button>}{message && <p role="status" aria-live="polite" className={styles.error}>{message}</p>}</section>
    <section className={styles.panel} aria-labelledby="decision-rounds-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>SEVEN-STAGE EVIDENCE</span><h2 id="decision-rounds-title">七阶段决策轮</h2></div>{data.hall.decisionRounds.length > 0 && <div className={styles.roundTools}><label htmlFor="decision-round">选择决策轮</label><select id="decision-round" value={selectedRound?.decisionRoundId ?? ""} onChange={(event) => setRoundId(event.target.value)}>{data.hall.decisionRounds.map((round) => <option key={round.decisionRoundId} value={round.decisionRoundId}>{round.strategyName} · {round.symbol} · {time(round.updatedAt)}</option>)}</select></div>}</div>{!selectedRound ? <p className={styles.empty}>暂无完整决策轮。系统不会补写七阶段结论。</p> : <><p className={styles.muted}>完整性：{selectedRound.completeness} · 模式：{selectedRound.executionMode} · 状态：{selectedRound.status}</p><div className={styles.stages}>{tradingHallAgentCatalog.map((agent) => { const event = eventFor(selectedRound.events, agent.key); return <article className={`${styles.stage} ${event ? "" : styles.waiting}`} key={agent.key}><span className={styles.stageIndex}>{agent.sequence}</span><h3>{agent.name}</h3><small>{agent.outputName}</small><p>{event?.conclusion ?? "本轮暂无该阶段服务端证据"}</p>{event && <code>{JSON.stringify(event.evidence)}</code>}</article>; })}</div></>}</section>
    <aside className={styles.callout} role="note"><strong>平台 Demo 证据边界：</strong>当前 Client 公共 API 未提供平台验证回执。这里仅展示客户官方 paper 组合、模拟成交与七阶段服务端记录；不把 Demo worker 状态、第三方订单或空数据描述为已验证成交。</aside>
  </div>;
}
