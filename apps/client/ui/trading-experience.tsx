"use client";

import { useCallback, useEffect, useState } from "react";

import type { CursorPage, PaperPortfolio, PaperTrade } from "@/packages/contracts/src/commercial-beta";
import { officialTradingHallStrategies } from "@/packages/contracts/src/trading-hall";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

import { clientErrorMessage, clientRequest } from "./client-api";
import styles from "./trading-experience.module.css";

type TradingData = {
  portfolios: PaperPortfolio[];
  trades: PaperTrade[];
  nextCursor: string | null;
};

const strategyLabels = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
} as const;

const statusLabels = {
  ACTIVE: "可启用",
  CLOSE_ONLY: "仅处理现有持仓",
  READ_ONLY: "只读",
} as const;

const runtimeLabels = {
  NOT_STARTED: "未启用",
  ACTIVE: "已启用",
  PAUSED: "已暂停",
  ENDED: "已停用",
  FAILED: "运行异常",
} as const;

function time(value: string | null, locale: string) {
  return value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value))
    : "—";
}

function pnlClass(value: string) {
  return value.startsWith("-") ? styles.negative : styles.positive;
}

function sideLabel(side: PaperTrade["side"], t: (value: string) => string) {
  if (side === "BUY") return t("买入");
  if (side === "SELL") return t("卖出");
  return "—";
}

function tradeResource(portfolioId?: string, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (portfolioId) params.set("portfolioId", portfolioId);
  if (cursor) params.set("cursor", cursor);
  return `/api/trading-hall/paper/trades?${params.toString()}`;
}

export default function TradingExperience({
  go,
  portfolioId,
  canManage = false,
}: {
  go?: unknown;
  portfolioId?: string;
  canManage?: boolean;
}) {
  void go;
  const { locale, t } = useAppLocale();
  const [data, setData] = useState<TradingData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [busy, setBusy] = useState(false);
  const [controlKey, setControlKey] = useState("");
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [selectedSymbols, setSelectedSymbols] = useState<Record<string, string>>(() => Object.fromEntries(
    officialTradingHallStrategies.map((strategy) => [strategy.code, strategy.symbols[0]]),
  ));

  const load = useCallback(async (preserveMessage = false) => {
    setState("loading");
    if (!preserveMessage) setMessage("");
    try {
      const [portfolioPage, tradePage] = await Promise.all([
        clientRequest<{ data: PaperPortfolio[] }>("/api/trading-hall/paper/portfolio", {}, t("模拟组合读取失败")),
        clientRequest<CursorPage<PaperTrade>>(tradeResource(portfolioId), {}, t("模拟成交记录读取失败")),
      ]);
      setData({
        portfolios: portfolioPage.data,
        trades: tradePage.data,
        nextCursor: tradePage.page.nextCursor,
      });
      setState("ready");
    } catch (error) {
      setMessageKind("error");
      setMessage(clientErrorMessage(error, t("模拟组合读取失败")));
      setState("error");
    }
  }, [portfolioId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function loadMore() {
    if (!data?.nextCursor || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const page = await clientRequest<CursorPage<PaperTrade>>(
        tradeResource(portfolioId, data.nextCursor),
        {},
        t("更多模拟成交读取失败"),
      );
      setData((current) => current
        ? { ...current, trades: [...current.trades, ...page.data], nextCursor: page.page.nextCursor }
        : current);
    } catch (error) {
      setMessageKind("error");
      setMessage(clientErrorMessage(error, t("更多模拟成交读取失败")));
    } finally {
      setBusy(false);
    }
  }

  async function changeCard(portfolio: PaperPortfolio) {
    if (!canManage || controlKey) return;
    const currentlyActive = portfolio.runtime.state === "ACTIVE" || portfolio.runtime.state === "PAUSED";
    if (!currentlyActive && !riskAcknowledged) {
      setMessageKind("error");
      setMessage(t("请先确认模拟策略风险边界"));
      return;
    }
    setControlKey(portfolio.strategyCode);
    setMessage("");
    try {
      if (currentlyActive) {
        if (!portfolio.runtime.subscriptionId) throw new Error(t("策略订阅状态不完整，不能停用"));
        await clientRequest(`/api/platform-strategy-subscriptions/${portfolio.runtime.subscriptionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        }, t("模拟策略停用失败"));
        setMessageKind("success");
        setMessage(`${t(strategyLabels[portfolio.strategyCode])} ${t("已停用。")}`);
      } else {
        await clientRequest(`/api/platform-strategies/${portfolio.strategyCode}/follow`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            symbol: selectedSymbols[portfolio.strategyCode],
            mode: "paper",
            riskConsent: true,
          }),
        }, t("模拟策略启用失败"));
        setMessageKind("success");
        setMessage(`${t(strategyLabels[portfolio.strategyCode])} ${t("已启用。")}`);
      }
      await load(true);
    } catch (error) {
      setMessageKind("error");
      setMessage(clientErrorMessage(error, t("模拟策略状态修改失败")));
    } finally {
      setControlKey("");
    }
  }

  if (state === "loading") {
    return <div className={styles.root} aria-busy="true" aria-label={t("模拟组合加载中")}><div className={styles.skeleton} /><div className={styles.skeleton} /></div>;
  }
  if (state === "error" || !data) {
    return <div className={styles.root}><section className={styles.panel}><h1>{t("模拟组合暂不可用")}</h1><p className={styles.error} role="alert">{message}</p><button className={styles.button} type="button" onClick={() => void load()}>{t("重试")}</button></section></div>;
  }

  const visiblePortfolios = portfolioId
    ? data.portfolios.filter((portfolio) => portfolio.id === portfolioId)
    : data.portfolios;
  const visibleTrades = portfolioId
    ? data.trades.filter((trade) => trade.portfolioId === portfolioId)
    : data.trades;

  return <div className={styles.root}>
    <header className={styles.hero}>
      <div><span className={styles.eyebrow}>{t("模拟资产")}</span><h1>{t("模拟组合")}</h1><p>{t("查看官方策略的模拟权益、持仓与成交记录。")}</p></div>
      <div className={styles.actions}><span className={styles.badge}>{t("Paper · 实盘路由关闭")}</span><button className={styles.button} type="button" onClick={() => void load()}>{t("刷新")}</button></div>
    </header>

    <section className={styles.panel} aria-labelledby="paper-portfolios-title">
      <div className={styles.panelHead}><div><h2 id="paper-portfolios-title">{t(portfolioId ? "组合详情" : "官方策略组合")}</h2></div><span className={styles.badge}>{visiblePortfolios.length} {t("个")}</span></div>
      <p className={styles.muted}>{t("策略已启用不代表已经产生模拟成交。")}</p>
      {canManage && <label className={styles.riskConsent}><input type="checkbox" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.target.checked)} /><span>{t("我了解这里展示的是独立模拟组合，不会连接或使用我的真实交易账户。")}</span></label>}
      {!portfolioId && data.portfolios.length !== 3 && <p className={styles.error} role="alert">{t("组合数据暂不完整，请稍后刷新后再查看整体表现。")}</p>}
      {portfolioId && visiblePortfolios.length === 0 && <p className={styles.error} role="alert">{t("未找到这个模拟组合，或当前账号无权查看。")}</p>}
      {visiblePortfolios.length === 0 && !portfolioId
        ? <p className={styles.empty}>{t("当前还没有模拟组合。会员激活后，系统会自动创建官方策略组合。")}</p>
        : <div className={styles.cards}>{visiblePortfolios.map((portfolio) => {
          const definition = officialTradingHallStrategies.find((strategy) => strategy.code === portfolio.strategyCode);
          const isEnabled = portfolio.runtime.state === "ACTIVE" || portfolio.runtime.state === "PAUSED";
          return <article className={styles.card} key={portfolio.id}>
            <header><div><h3>{t(strategyLabels[portfolio.strategyCode])}</h3></div><div className={styles.cardStatuses}><span className={styles.badge}>{t(statusLabels[portfolio.status])}</span><span className={styles.badge}>{t(runtimeLabels[portfolio.runtime.state])}</span></div></header>
            <p>{t("初始模拟资金")} {portfolio.initialCashUsdt} USDT, {t("各组合独立计算。")}</p>
            <div className={styles.runtimeEvidence}><span>{t("最近更新：")}{portfolio.runtime.lastDecisionAt ? time(portfolio.runtime.lastDecisionAt, locale) : t("暂无")}</span></div>
            {canManage && <div className={styles.cardControls}>
              {!isEnabled && <label><span>{t("现货资产")}</span><select aria-label={`${t(strategyLabels[portfolio.strategyCode])} ${t("现货资产")}`} value={selectedSymbols[portfolio.strategyCode]} onChange={(event) => setSelectedSymbols((current) => ({ ...current, [portfolio.strategyCode]: event.target.value }))}>{(definition?.symbols ?? []).map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}</select></label>}
              <button className={styles.button} type="button" disabled={Boolean(controlKey) || (!isEnabled && (!riskAcknowledged || portfolio.status !== "ACTIVE"))} onClick={() => void changeCard(portfolio)}>{t(controlKey === portfolio.strategyCode ? "正在提交…" : isEnabled ? "停用策略" : portfolio.status === "ACTIVE" ? "启用策略" : "当前不可启用")}</button>
            </div>}
            <div className={styles.metrics}>
              <div className={styles.metric}><span>{t("当前权益")}</span><b>{portfolio.equityUsdt} USDT</b></div>
              <div className={styles.metric}><span>{t("可用现金")}</span><b>{portfolio.cashUsdt} USDT</b></div>
              <div className={styles.metric}><span>{t("已实现收益")}</span><b className={pnlClass(portfolio.realizedNetPnlUsdt)}>{portfolio.realizedNetPnlUsdt} USDT</b></div>
              <div className={styles.metric}><span>{t("持仓浮盈亏")}</span><b className={pnlClass(portfolio.unrealizedPnlUsdt)}>{portfolio.unrealizedPnlUsdt} USDT</b></div>
            </div>
            <div className={styles.positions}>{portfolio.positions.length === 0
              ? <span className={styles.muted}>{t("暂无现货持仓")}</span>
              : portfolio.positions.map((position) => <div className={styles.position} key={position.id}><b>{position.symbol}</b><span>{position.quantity}</span><span>{t("成本")} {position.averageEntryPrice}</span><span className={pnlClass(position.unrealizedPnlUsdt)}>{t("浮盈亏")} {position.unrealizedPnlUsdt} USDT</span></div>)}</div>
          </article>;
        })}</div>}
    </section>

    <section className={styles.panel} aria-labelledby="paper-trades-title">
      <div className={styles.panelHead}><div><h2 id="paper-trades-title">{t("模拟成交")}</h2></div><span className={styles.badge}>{visibleTrades.length} {t("条")}</span></div>
      {visibleTrades.length === 0
        ? <p className={styles.empty}>{t("暂无模拟成交。")}</p>
        : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>{t("成交时间")}</th><th>{t("策略")}</th><th>{t("资产")}</th><th>{t("方向")}</th><th>{t("数量")}</th><th>{t("成交价")}</th><th>{t("手续费")}</th><th>{t("已实现收益")}</th></tr></thead><tbody>{visibleTrades.map((trade) => <tr key={trade.id}><td>{time(trade.filledAt, locale)}</td><td>{t(strategyLabels[trade.strategyCode])}</td><td>{trade.symbol}</td><td>{sideLabel(trade.side, t)}</td><td>{trade.quantity}</td><td>{trade.priceUsdt}</td><td>{trade.feeUsdt}</td><td className={pnlClass(trade.realizedNetPnlUsdt)}>{trade.realizedNetPnlUsdt}</td></tr>)}</tbody></table></div>}
      {data.nextCursor && <button className={styles.button} type="button" disabled={busy} onClick={() => void loadMore()}>{t(busy ? "正在读取…" : "加载更多")}</button>}
      {message && <p role={messageKind === "error" ? "alert" : "status"} aria-live={messageKind === "error" ? "assertive" : "polite"} className={messageKind === "error" ? styles.error : styles.callout}>{message}</p>}
    </section>
  </div>;
}
