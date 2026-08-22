"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientDemoSummary, CursorPage, PaperPortfolio, PaperTrade } from "@/packages/contracts/src/commercial-beta";
import { officialTradingHallStrategies, tradingHallAgentCatalog, type TradingHallDecisionEvent, type TradingHallPayload } from "@/packages/contracts/src/trading-hall";
import { clientErrorMessage, clientRequest } from "./client-api";
import styles from "./trading-experience.module.css";

type TradingData = { hall: TradingHallPayload; portfolios: PaperPortfolio[]; trades: PaperTrade[]; nextCursor: string | null; demo: ClientDemoSummary | null };
const strategyLabels = { ai_conservative: "AI 稳健型", ai_balanced: "AI 平衡型", ai_aggressive: "AI 激进型" } as const;
const statusLabels = { ACTIVE: "允许新开仓", CLOSE_ONLY: "仅平仓", READ_ONLY: "只读" } as const;
const runtimeLabels = { NOT_STARTED: "未启用", ACTIVE: "已启用", PAUSED: "已暂停", ENDED: "已停用", FAILED: "执行失败" } as const;
const demoProviderStatusLabels: Record<ClientDemoSummary["providers"][number]["status"], string> = { NOT_CONFIGURED: "未配置", DISABLED: "已停用", PAUSED: "紧急暂停", UNVERIFIED: "尚未验证", VERIFIED: "验证通过", VERIFICATION_FAILED: "验证失败" };
const demoCardStatusLabels: Record<ClientDemoSummary["providers"][number]["cards"][number]["status"], string> = { NOT_TESTED: "尚未测试", PAUSED: "紧急暂停", PENDING: "等待处理", RUNNING: "测试处理中", UNKNOWN: "状态未知", RETRY_WAIT: "等待重试", RECONCILE_WAIT: "等待查单", FILLED: "测试成交", CANCELLED: "已取消", FAILED: "测试失败", QUARANTINED: "已隔离" };
const demoReceiptStatusLabels: Record<NonNullable<ClientDemoSummary["providers"][number]["cards"][number]["receiptSummary"]>["status"], string> = { ACCEPTED: "测试请求已接受", PARTIALLY_FILLED: "测试部分成交", FILLED: "测试成交", CANCELLED: "测试已取消", REJECTED: "测试被拒绝" };
function time(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—"; }
function pnlClass(value: string) { return value.startsWith("-") ? styles.negative : styles.positive; }
function eventFor(events: TradingHallDecisionEvent[], role: string) { return events.find((event) => event.role === role); }

function tradeResource(portfolioId?: string, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (portfolioId) params.set("portfolioId", portfolioId);
  if (cursor) params.set("cursor", cursor);
  return `/api/trading-hall/paper/trades?${params.toString()}`;
}

export default function TradingExperience({ go, portfolioId, canManage = false }: { go?: unknown; portfolioId?: string; canManage?: boolean }) {
  void go;
  const [data, setData] = useState<TradingData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [busy, setBusy] = useState(false);
  const [controlKey, setControlKey] = useState("");
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [demoError, setDemoError] = useState("");
  const [selectedSymbols, setSelectedSymbols] = useState<Record<string, string>>(() => Object.fromEntries(
    officialTradingHallStrategies.map((strategy) => [strategy.code, strategy.symbols[0]]),
  ));
  const [roundId, setRoundId] = useState("");
  const load = useCallback(async (preserveMessage = false) => {
    setState("loading");
    if (!preserveMessage) setMessage("");
    try {
      const [hall, portfolioPage, tradePage] = await Promise.all([
        clientRequest<TradingHallPayload>("/api/trading-hall", {}, "七阶段决策记录读取失败"),
        clientRequest<{ data: PaperPortfolio[] }>("/api/trading-hall/paper/portfolio", {}, "官方三卡组合读取失败"),
        clientRequest<CursorPage<PaperTrade>>(tradeResource(portfolioId), {}, "模拟成交记录读取失败"),
      ]);
      let demo: ClientDemoSummary | null = null;
      try {
        demo = await clientRequest<ClientDemoSummary>("/api/trading-hall/paper/platform-demo-summary", {}, "平台 Demo 安全摘要读取失败");
        setDemoError("");
      } catch (error) { setDemoError(clientErrorMessage(error, "平台 Demo 安全摘要读取失败")); }
      setData({ hall, portfolios: portfolioPage.data, trades: tradePage.data, nextCursor: tradePage.page.nextCursor, demo });
      setRoundId((current) => current || hall.decisionRounds[0]?.decisionRoundId || ""); setState("ready");
    } catch (error) { setMessageKind("error"); setMessage(clientErrorMessage(error, "交易中心读取失败")); setState("error"); }
  }, [portfolioId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function loadMore() {
    if (!data?.nextCursor || busy) return;
    setBusy(true); setMessage("");
    try {
      const page = await clientRequest<CursorPage<PaperTrade>>(tradeResource(portfolioId, data.nextCursor), {}, "更多模拟成交读取失败");
      setData((current) => current ? { ...current, trades: [...current.trades, ...page.data], nextCursor: page.page.nextCursor } : current);
    } catch (error) { setMessageKind("error"); setMessage(clientErrorMessage(error, "更多模拟成交读取失败")); }
    finally { setBusy(false); }
  }
  async function changeCard(portfolio: PaperPortfolio) {
    if (!canManage || controlKey) return;
    const currentlyActive = portfolio.runtime.state === "ACTIVE" || portfolio.runtime.state === "PAUSED";
    if (!currentlyActive && !riskAcknowledged) { setMessageKind("error"); setMessage("请先确认模拟策略风险边界"); return; }
    setControlKey(portfolio.strategyCode); setMessage("");
    try {
      if (currentlyActive) {
        if (!portfolio.runtime.subscriptionId) throw new Error("策略订阅状态不完整，不能停用");
        await clientRequest(`/api/platform-strategy-subscriptions/${portfolio.runtime.subscriptionId}`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }),
        }, "模拟策略停用失败");
        setMessageKind("success"); setMessage(`${strategyLabels[portfolio.strategyCode]} 已停用；不会再处理新的决策轮。`);
      } else {
        await clientRequest(`/api/platform-strategies/${portfolio.strategyCode}/follow`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ symbol: selectedSymbols[portfolio.strategyCode], mode: "paper", riskConsent: true }),
        }, "模拟策略启用失败");
        setMessageKind("success"); setMessage(`${strategyLabels[portfolio.strategyCode]} 已启用；这不代表 Worker 当前健康或已产生模拟成交。`);
      }
      await load(true);
    } catch (error) { setMessageKind("error"); setMessage(clientErrorMessage(error, "模拟策略状态修改失败")); }
    finally { setControlKey(""); }
  }
  const selectedRound = useMemo(() => data?.hall.decisionRounds.find((round) => round.decisionRoundId === roundId) ?? data?.hall.decisionRounds[0] ?? null, [data, roundId]);

  if (state === "loading") return <div className={styles.root} aria-busy="true" aria-label="交易中心加载中"><div className={styles.skeleton} /><div className={styles.skeleton} /></div>;
  if (state === "error" || !data) return <div className={styles.root}><section className={styles.panel}><h1>交易中心暂不可用</h1><p className={styles.error} role="alert">{message}</p><button className={styles.button} type="button" onClick={() => void load()}>重试</button></section></div>;

  const visiblePortfolios = portfolioId ? data.portfolios.filter((portfolio) => portfolio.id === portfolioId) : data.portfolios;
  const visibleTrades = portfolioId ? data.trades.filter((trade) => trade.portfolioId === portfolioId) : data.trades;
  return <div className={styles.root}>
    <header className={styles.hero}><div><span className={styles.eyebrow}>OFFICIAL PAPER · SPOT USDT</span><h1>交易中心</h1><p>查看官方三卡独立模拟资金、现货持仓、成交历史和七阶段决策证据。真实订单路由保持关闭。</p></div><div className={styles.actions}><span className={styles.badge}>{data.hall.productBoundary.currentExecutionMode}</span><button className={styles.button} type="button" onClick={() => void load()}>刷新证据</button></div></header>
    <section className={styles.boundary} aria-label="产品执行边界"><div><span>市场</span><b>{data.hall.productBoundary.targetMarket}</b></div><div><span>资产</span><b>{data.hall.productBoundary.symbols.join(" · ")}</b></div><div><span>杠杆 / 做空</span><b>关闭 / 关闭</b></div><div><span>真实订单</span><b>{data.hall.productBoundary.realOrderRoutingEnabled ? "已开启" : "关闭"}</b></div></section>
    <section className={styles.panel} aria-labelledby="paper-portfolios-title">
      <div className={styles.panelHead}><div><span className={styles.eyebrow}>THREE INDEPENDENT PORTFOLIOS</span><h2 id="paper-portfolios-title">{portfolioId ? "模拟组合详情" : "官方三卡模拟组合"}</h2></div><span className={styles.badge}>{visiblePortfolios.length} / {portfolioId ? 1 : 3}</span></div>
      {canManage && <label className={styles.riskConsent}><input type="checkbox" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.target.checked)} /><span>我理解这是客户独立 Paper 组合，不是真实投资，也不要求或使用我的交易所账户。</span></label>}
      {!portfolioId && data.portfolios.length !== 3 && <p className={styles.error} role="alert">官方三卡组合不完整，当前数据仅供核对；请勿据此判断完整组合表现。</p>}
      {portfolioId && visiblePortfolios.length === 0 && <p className={styles.error} role="alert">未找到当前账号所属的模拟组合，或该组合已不可见。</p>}
      {visiblePortfolios.length === 0 && !portfolioId ? <p className={styles.empty}>当前会员尚无官方模拟组合。组合仅由服务端在会员激活后初始化。</p> : <div className={styles.cards}>{visiblePortfolios.map((portfolio) => {
        const definition = officialTradingHallStrategies.find((strategy) => strategy.code === portfolio.strategyCode);
        const isEnabled = portfolio.runtime.state === "ACTIVE" || portfolio.runtime.state === "PAUSED";
        return <article className={styles.card} key={portfolio.id}>
          <header><div><span className={styles.eyebrow}>{portfolio.strategyCode}</span><h3>{strategyLabels[portfolio.strategyCode]}</h3></div><div className={styles.cardStatuses}><span className={styles.badge}>{statusLabels[portfolio.status]}</span><span className={styles.badge}>{runtimeLabels[portfolio.runtime.state]}</span></div></header>
          <p>每张卡本金固定为 {portfolio.initialCashUsdt} USDT；不可从 Client 修改。组合访问状态与策略启用状态彼此独立。</p>
          <div className={styles.runtimeEvidence}><span>最近决策：{portfolio.runtime.lastDecisionAt ? time(portfolio.runtime.lastDecisionAt) : "暂无"}</span><span>决策序号：{portfolio.runtime.lastCycleSequence || "—"}</span><span>“已启用”只表示允许处理新决策，不代表 Worker 健康、在线或已成交。</span></div>
          {canManage && <div className={styles.cardControls}>
            {!isEnabled && <label><span>现货资产</span><select aria-label={`${strategyLabels[portfolio.strategyCode]} 现货资产`} value={selectedSymbols[portfolio.strategyCode]} onChange={(event) => setSelectedSymbols((current) => ({ ...current, [portfolio.strategyCode]: event.target.value }))}>{(definition?.symbols ?? []).map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>}
            <button className={styles.button} type="button" disabled={Boolean(controlKey) || (!isEnabled && (!riskAcknowledged || portfolio.status !== "ACTIVE"))} onClick={() => void changeCard(portfolio)}>{controlKey === portfolio.strategyCode ? "正在提交…" : isEnabled ? "停用策略" : portfolio.status === "ACTIVE" ? "启用策略" : "当前不可启用"}</button>
          </div>}
          <div className={styles.metrics}><div className={styles.metric}><span>权益</span><b>{portfolio.equityUsdt} USDT</b></div><div className={styles.metric}><span>现金</span><b>{portfolio.cashUsdt} USDT</b></div><div className={styles.metric}><span>已实现净收益</span><b className={pnlClass(portfolio.realizedNetPnlUsdt)}>{portfolio.realizedNetPnlUsdt}</b></div><div className={styles.metric}><span>未实现收益</span><b className={pnlClass(portfolio.unrealizedPnlUsdt)}>{portfolio.unrealizedPnlUsdt}</b></div></div>
          <div className={styles.positions}>{portfolio.positions.length === 0 ? <span className={styles.muted}>暂无现货持仓</span> : portfolio.positions.map((position) => <div className={styles.position} key={position.id}><b>{position.symbol}</b><span>{position.quantity}</span><span>成本 {position.averageEntryPrice}</span><span className={pnlClass(position.unrealizedPnlUsdt)}>浮盈亏 {position.unrealizedPnlUsdt}</span></div>)}</div>
        </article>;
      })}</div>}
    </section>
    <section className={styles.panel} aria-labelledby="paper-trades-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>IMMUTABLE PAPER FILLS</span><h2 id="paper-trades-title">模拟成交历史</h2></div><span className={styles.badge}>{visibleTrades.length} 条</span></div>{visibleTrades.length === 0 ? <p className={styles.empty}>暂无模拟成交。这里不会生成占位订单或示例收益。</p> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>成交时间</th><th>策略</th><th>现货资产</th><th>方向</th><th>数量</th><th>成交价</th><th>手续费</th><th>已实现净收益</th><th>决策轮</th></tr></thead><tbody>{visibleTrades.map((trade) => <tr key={trade.id}><td>{time(trade.filledAt)}</td><td>{strategyLabels[trade.strategyCode]}</td><td>{trade.symbol}</td><td>{trade.side}</td><td>{trade.quantity}</td><td>{trade.priceUsdt}</td><td>{trade.feeUsdt}</td><td className={pnlClass(trade.realizedNetPnlUsdt)}>{trade.realizedNetPnlUsdt}</td><td>{trade.decisionRoundId}</td></tr>)}</tbody></table></div>}{data.nextCursor && <button className={styles.button} type="button" disabled={busy} onClick={() => void loadMore()}>{busy ? "正在读取…" : "加载更多"}</button>}{message && <p role={messageKind === "error" ? "alert" : "status"} aria-live={messageKind === "error" ? "assertive" : "polite"} className={messageKind === "error" ? styles.error : styles.callout}>{message}</p>}</section>
    <section className={styles.panel} aria-labelledby="decision-rounds-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>SEVEN-STAGE EVIDENCE</span><h2 id="decision-rounds-title">七阶段决策轮</h2></div>{data.hall.decisionRounds.length > 0 && <div className={styles.roundTools}><label htmlFor="decision-round">选择决策轮</label><select id="decision-round" value={selectedRound?.decisionRoundId ?? ""} onChange={(event) => setRoundId(event.target.value)}>{data.hall.decisionRounds.map((round) => <option key={round.decisionRoundId} value={round.decisionRoundId}>{round.strategyName} · {round.symbol} · {time(round.updatedAt)}</option>)}</select></div>}</div>{!selectedRound ? <p className={styles.empty}>暂无完整决策轮。系统不会补写七阶段结论。</p> : <><p className={styles.muted}>完整性：{selectedRound.completeness} · 模式：{selectedRound.executionMode} · 状态：{selectedRound.status}</p>{selectedRound.sharedDecisionRoundId && <p className={styles.muted}>这是该策略卡在这根 K 线上的公共决策轮：七阶段结论对订阅同一张卡的所有客户完全相同，不含任何客户数据。你的仓位与风控准入按你的组合单独判定。</p>}<div className={styles.stages}>{tradingHallAgentCatalog.map((agent) => { const event = eventFor(selectedRound.events, agent.key); return <article className={`${styles.stage} ${event ? "" : styles.waiting}`} key={agent.key}><span className={styles.stageIndex}>{agent.sequence}</span><h3>{agent.name}</h3><small>{agent.outputName}</small><p>{event?.conclusion ?? "本轮暂无该阶段服务端证据"}</p>{event && <code>{JSON.stringify(event.evidence)}</code>}</article>; })}</div></>}</section>
    <section className={styles.panel} aria-labelledby="demo-summary-title"><div className={styles.panelHead}><div><span className={styles.eyebrow}>SANITIZED PLATFORM TEST EVIDENCE</span><h2 id="demo-summary-title">平台 Demo 安全摘要</h2></div><span className={styles.badge}>不影响客户 Paper</span></div>{demoError ? <p className={styles.error} role="status">{demoError}；客户 Paper 组合与成交记录仍可独立核对。</p> : !data.demo ? <p className={styles.empty}>暂无可公开的平台测试证据；系统不会用占位回执补齐。</p> : <div className={styles.demoGrid}>{data.demo.providers.map((provider) => <article className={styles.demoProvider} key={provider.provider}><header><div><span className={styles.eyebrow}>{provider.environment}</span><h3>{provider.provider.toUpperCase()}</h3></div><span className={styles.badge}>{demoProviderStatusLabels[provider.status]}</span></header><p>最近检测：{time(provider.lastTestedAt)}</p><ul>{provider.cards.map((card) => <li key={card.strategyCode}><span>{strategyLabels[card.strategyCode]}</span><b>{card.receiptSummary ? demoReceiptStatusLabels[card.receiptSummary.status] : demoCardStatusLabels[card.status]}</b><small>{time(card.receiptSummary?.observedAt ?? card.lastTestedAt)}</small></li>)}</ul></article>)}</div>}</section>
    <aside className={styles.callout} role="note"><strong>平台 Demo 证据边界：</strong>这里只展示脱敏的平台测试账户摘要，不包含密钥、订单标识、端点或原始回执。平台 Demo 不代表客户真实成交；其成功或失败都不会改变客户 Paper 余额、成交或绩效账单。</aside>
  </div>;
}
