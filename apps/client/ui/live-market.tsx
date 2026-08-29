"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ProductIcon } from "./coin-icon";
import styles from "./live-market.module.css";
import {
  deriveMarketFeedStatus,
  isRecentMarketPayload,
  marketPayloadTimestamp,
  type MarketTransportState,
  type NewsContentFreshness,
} from "@/lib/market-content-freshness";
import { useAppLocale } from "@/packages/ui/src/app-locale-context";

type Market = "crypto" | "forex" | "metals" | "stocks";
type Instrument = { symbol: string; label: string; name: string; nameZh: string; category: Market; providerSymbol: string; aliases: string[] };
type Quote = { price: number; change: number; changePercent: number; high: number; low: number; volume: number; open: number; live: boolean; source: string; updatedAt: string; error?: string };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type NewsItem = { id: string; title: string; summary: string; category: "快讯" | "资金流向" | "公告"; publishedAt: string | null; source: string; link: string; live: boolean; freshness: NewsContentFreshness; timeLabel: string };
type ApiResult<T> = { ok: boolean; data: T | null; error: string };

const marketTabs: Array<[Market, string, string]> = [["crypto", "加密货币", "CRYPTO"], ["forex", "外汇", "FOREX"], ["metals", "贵金属", "METALS"], ["stocks", "美股", "US EQUITIES"]];
const periods = ["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W"];
const fallbackInstruments: Instrument[] = [{ symbol: "BTCUSD", label: "BTC/USD", name: "Bitcoin", nameZh: "比特币", category: "crypto", providerSymbol: "BTCUSDT", aliases: ["btc", "bitcoin", "比特币"] }];

function price(value: number) { if (!value) return "—"; return value < 1 ? value.toFixed(5) : value.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function compact(value: number) { if (!value) return "—"; if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`; if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`; if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`; return value.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function candleTimeLabel(timestamp: number, interval: string, locale: string) { const date = new Date(timestamp); return interval === "1D" || interval === "1W" ? date.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" }) : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }); }
function mergeCandleRows(...groups: Candle[][]) { const rows = new Map<number, Candle>(); groups.flat().forEach(item => rows.set(item.time, item)); return [...rows.values()].sort((a, b) => a.time - b.time).slice(-1500); }
async function apiJson<T>(url: string, t: (value: string) => string): Promise<ApiResult<T>> { try { const response = await fetch(url, { cache: "no-store" }); const data = await response.json().catch(() => null) as (T & { error?: string }) | null; return { ok: response.ok && Boolean(data), data, error: response.ok ? "" : data?.error || `${t("接口返回 HTTP")} ${response.status}` }; } catch (error) { return { ok: false, data: null, error: error instanceof Error ? error.message : t("网络连接失败") }; } }
function isValidQuotePayload(value: Quote) { return value.live && value.price > 0 && value.high > 0 && value.low > 0 && value.open > 0 && value.volume >= 0 && [value.price, value.change, value.changePercent, value.high, value.low, value.volume, value.open].every(Number.isFinite); }

function NewsCard({ item, t }: { item: NewsItem; t: (value: string) => string }) {
  const content = <>
    <header><span>{item.category}</span><time>{item.timeLabel}</time></header>
    <h3>{item.title}</h3>
    <p>{item.summary || t("打开原文查看完整内容。")}</p>
    <footer><span>{item.source}</span><b>{t(item.link ? "查看原文 ↗" : "备用提示")}</b></footer>
  </>;
  return item.link
    ? <a className={styles.newsCard} href={item.link} target="_blank" rel="noreferrer">{content}</a>
    : <article className={`${styles.newsCard} ${styles.isFallback}`}>{content}</article>;
}

export default function LiveMarket() {
  const { locale, t } = useAppLocale();
  const [instruments, setInstruments] = useState<Instrument[]>(fallbackInstruments), [market, setMarket] = useState<Market>("crypto"), [symbol, setSymbol] = useState("BTCUSD"), [query, setQuery] = useState(""), [period, setPeriod] = useState("15m"), [quote, setQuote] = useState<Quote | null>(null), [candles, setCandles] = useState<Candle[]>([]), [hovered, setHovered] = useState<Candle | null>(null), [zoom, setZoom] = useState(1), [message, setMessage] = useState(""), [loading, setLoading] = useState(true), [refreshKey, setRefreshKey] = useState(0), [marketTransport, setMarketTransport] = useState<MarketTransportState>("connecting"), [lastMarketPayloadAt, setLastMarketPayloadAt] = useState<number | null>(null), [freshnessNow, setFreshnessNow] = useState(() => Date.now()), [loadingHistory, setLoadingHistory] = useState(false), [historyExhausted, setHistoryExhausted] = useState(false), [news, setNews] = useState<NewsItem[]>([]), [newsMessage, setNewsMessage] = useState(""), [newsFreshness, setNewsFreshness] = useState<NewsContentFreshness>("unavailable"), [newsObservedAt, setNewsObservedAt] = useState("");
  const chartRef = useRef<HTMLElement>(null), chartViewportRef = useRef<HTMLDivElement>(null), searchInputRef = useRef<HTMLInputElement>(null), dragRef = useRef<{ x: number; scrollLeft: number } | null>(null), historyLoadingRef = useRef(false), needsInitialScrollRef = useRef(true);
  const current = instruments.find(item => item.symbol === symbol) || instruments[0];
  const marketInstruments = useMemo(() => instruments.filter(item => item.category === market), [instruments, market]);
  const searchResults = useMemo(() => { const normalized = query.trim().toLowerCase(); if (!normalized) return []; return instruments.filter(item => [item.symbol, item.label, item.name, item.nameZh, ...item.aliases].join(" ").toLowerCase().includes(normalized)).slice(0, 8); }, [instruments, query]);
  const marketFeedStatus = deriveMarketFeedStatus({ transport: marketTransport, payloadAt: lastMarketPayloadAt, now: new Date(freshnessNow) });
  function selectInstrument(item: Instrument) { setMarket(item.category); setSymbol(item.symbol); setQuery(""); setQuote(null); setCandles([]); setMessage(""); setMarketTransport("connecting"); setLastMarketPayloadAt(null); setHistoryExhausted(false); needsInitialScrollRef.current = true; if (typeof window !== "undefined") window.history.replaceState(null, "", `/market?symbol=${encodeURIComponent(item.symbol)}`); }
  function selectMarket(next: Market) { const first = instruments.find(item => item.category === next); if (first) selectInstrument(first); else setMarket(next); }
  function selectPeriod(next: string) { setPeriod(next); setCandles([]); setHovered(null); setHistoryExhausted(false); needsInitialScrollRef.current = true; }
  useEffect(() => { fetch("/api/market/instruments", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then(data => { const rows = Array.isArray(data?.instruments) ? data.instruments as Instrument[] : fallbackInstruments; setInstruments(rows); const urlSymbol = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("symbol")?.toUpperCase().replace("/", "") : ""; const requested = rows.find(item => item.symbol === urlSymbol); if (requested) { setMarket(requested.category); setSymbol(requested.symbol); } }).catch(() => setInstruments(fallbackInstruments)); }, []);
  useEffect(() => { const focusSearch = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchInputRef.current?.focus(); } }; document.addEventListener("keydown", focusSearch); return () => document.removeEventListener("keydown", focusSearch); }, []);
  useEffect(() => { const timer = window.setInterval(() => { const now = Date.now(); setFreshnessNow(now); if (deriveMarketFeedStatus({ transport: marketTransport, payloadAt: lastMarketPayloadAt, now: new Date(now) }) !== "live") setQuote(previous => previous?.live ? { ...previous, live: false } : previous); }, 1_000); return () => window.clearInterval(timer); }, [lastMarketPayloadAt, marketTransport]);
  useEffect(() => { if (!current) return; let active = true, inFlight = false; const load = async () => { if (inFlight) return; inFlight = true; if (active) setLoading(true); const [quoteResult, candleResult] = await Promise.all([apiJson<Quote>(`/api/market/quote?symbol=${encodeURIComponent(current.symbol)}&category=${current.category}`, t), apiJson<{ candles?: Candle[]; error?: string }>(`/api/market/candles?symbol=${encodeURIComponent(current.symbol)}&category=${current.category}&interval=${period}`, t)]); if (active) { if (quoteResult.ok && quoteResult.data && isValidQuotePayload(quoteResult.data)) { const observedAt = new Date(); const payloadAt = marketPayloadTimestamp(quoteResult.data.updatedAt, observedAt); if (payloadAt === null) { setQuote({ ...quoteResult.data, live: false }); setMarketTransport("offline"); } else { const recent = isRecentMarketPayload(payloadAt, observedAt); setQuote({ ...quoteResult.data, live: recent }); setLastMarketPayloadAt(payloadAt); setFreshnessNow(observedAt.getTime()); setMarketTransport("active"); } } else { setQuote(previous => previous ? { ...previous, live: false } : previous); setMarketTransport("offline"); } if (candleResult.ok && candleResult.data) { const incoming = candleResult.data.candles || []; setCandles(previous => previous.length ? mergeCandleRows(previous, incoming) : incoming); } setMessage([quoteResult.error, candleResult.error].filter(Boolean).join(locale === "zh-CN" ? "；" : "; ")); setLoading(false); } inFlight = false; }; void load(); const delay = current.category === "crypto" && marketTransport === "active" ? 15_000 : 1_000; const timer = window.setInterval(() => void load(), delay); return () => { active = false; window.clearInterval(timer); }; }, [current, locale, period, refreshKey, marketTransport, t]);
  useEffect(() => { if (!current) return; let active = true; const coin = current.symbol.replace(/USD$/, ""); const load = async () => { const result = await apiJson<{ items?: NewsItem[]; observedAt?: string; contentFreshness?: NewsContentFreshness; stale?: boolean; error?: string }>(`/api/market/news?coin=${encodeURIComponent(coin)}`, t); if (!active) return; const freshness = result.data?.contentFreshness || "unavailable"; setNews(result.data?.items || []); setNewsFreshness(freshness); setNewsObservedAt(result.data?.observedAt || ""); setNewsMessage(result.error || t(freshness === "stale" ? "新闻源已响应，但最新内容超过新鲜度阈值。" : freshness === "unknown" ? "新闻源已响应，但内容发布时间不可验证。" : freshness === "unavailable" ? "新闻源暂时不可用，当前显示明确标记的备用提示。" : "")); }; void load(); const timer = window.setInterval(() => void load(), 60_000); return () => { active = false; window.clearInterval(timer); }; }, [current, refreshKey, t]);
  useEffect(() => { if (!candles.length || !needsInitialScrollRef.current) return; needsInitialScrollRef.current = false; const frame = window.requestAnimationFrame(() => { const viewport = chartViewportRef.current; if (viewport) viewport.scrollLeft = viewport.scrollWidth; }); return () => window.cancelAnimationFrame(frame); }, [candles.length]);
  const visibleCandles = useMemo(() => candles.slice(-1500), [candles]);
  const bounds = useMemo(() => { const values = visibleCandles.flatMap(item => [item.high, item.low]).filter(value => value > 0); const rawMax = Math.max(...values, quote?.price || 1); const rawMin = Math.min(...values, quote?.price || rawMax); const range = rawMax === rawMin ? Math.max(rawMax * .01, 1) : rawMax - rawMin; const padding = range * .07; return { max: rawMax + padding, min: Math.max(0, rawMin - padding) }; }, [visibleCandles, quote]);
  const axis = Array.from({ length: 6 }, (_, index) => bounds.max - ((bounds.max - bounds.min) / 5) * index);
  const maxVisibleVolume = useMemo(() => Math.max(...visibleCandles.map(item => item.volume), 1), [visibleCandles]);
  function percent(value: number) { return ((bounds.max - value) / (bounds.max - bounds.min)) * 100; }
  function fullscreen() { void chartRef.current?.requestFullscreen?.(); }
  function beginChartDrag(event: PointerEvent<HTMLDivElement>) { dragRef.current = { x: event.clientX, scrollLeft: event.currentTarget.scrollLeft }; event.currentTarget.setPointerCapture(event.pointerId); }
  function moveChartDrag(event: PointerEvent<HTMLDivElement>) { if (!dragRef.current) return; event.currentTarget.scrollLeft = dragRef.current.scrollLeft - (event.clientX - dragRef.current.x); if (event.currentTarget.scrollLeft < 100) void loadOlderCandles(); }
  function endChartDrag() { dragRef.current = null; }
  function changeZoom(delta: number) { const viewport = chartViewportRef.current; const distanceFromRight = viewport ? viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft : 0; setZoom(value => Math.max(1, Math.min(4, value + delta))); window.requestAnimationFrame(() => { const nextViewport = chartViewportRef.current; if (nextViewport) nextViewport.scrollLeft = Math.max(0, nextViewport.scrollWidth - nextViewport.clientWidth - distanceFromRight); }); }
  async function loadOlderCandles() {
    if (!current || !candles.length || historyLoadingRef.current || historyExhausted) return;
    historyLoadingRef.current = true;
    setLoadingHistory(true);
    const viewport = chartViewportRef.current;
    const oldScrollWidth = viewport?.scrollWidth || 0;
    const oldestTime = candles[0].time;
    const result = await apiJson<{ candles?: Candle[]; hasMore?: boolean; error?: string }>(`/api/market/candles?symbol=${encodeURIComponent(current.symbol)}&category=${current.category}&interval=${period}&before=${oldestTime}&limit=500`, t);
    const olderRows = result.data?.candles || [];
    if (result.ok && olderRows.length) {
      setCandles(previous => mergeCandleRows(olderRows, previous));
      setHistoryExhausted(result.data?.hasMore === false || olderRows.every(item => candles.some(existing => existing.time === item.time)));
      window.requestAnimationFrame(() => { const nextViewport = chartViewportRef.current; if (nextViewport) nextViewport.scrollLeft += Math.max(0, nextViewport.scrollWidth - oldScrollWidth); });
    } else if (result.ok) setHistoryExhausted(true);
    historyLoadingRef.current = false;
    setLoadingHistory(false);
  }
  const marketStatusLabel = t(marketFeedStatus === "live" ? "实时行情" : marketFeedStatus === "stale" ? "行情数据已过期" : marketFeedStatus === "offline" ? "行情源离线" : "正在连接");
  const marketStreamLabel = t(marketFeedStatus === "live" ? "最近数据已验证" : marketFeedStatus === "stale" ? "等待新鲜数据" : marketFeedStatus === "offline" ? "数据源离线" : "连接行情源");
  const newsStatusLabel = t(newsFreshness === "fresh" ? "内容新鲜" : newsFreshness === "stale" ? "内容已过期" : newsFreshness === "unknown" ? "发布时间未知" : "备用模式");

  return <div className={styles.page}><div className={styles.title}><div><h1>{t("行情中心")}</h1><p>{t("覆盖加密货币、外汇、贵金属及美股市场")}</p></div><div className={styles.titleActions}><button type="button" onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>{t(loading ? "更新中…" : "立即刷新")}</button><span className={marketFeedStatus === "live" ? "market-live-status" : "market-offline-status"}><i />{marketStatusLabel}{quote?.updatedAt && <time>{new Date(quote.updatedAt).toLocaleTimeString(locale)}</time>}</span></div></div>
    <nav className={styles.categoryTabs} aria-label={t("市场分类")}>{marketTabs.map(([key, label, code]) => <button key={key} className={market === key ? "active" : ""} onClick={() => selectMarket(key)}><span>{t(label)}</span><small>{code}</small></button>)}</nav>
    <section className={styles.selectorPanel}><label className={styles.searchBox}><span aria-hidden="true">⌕</span><input ref={searchInputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索交易品种 / Symbol / 名称")} aria-label={t("搜索交易品种")}/><kbd>⌘ K</kbd></label>{searchResults.length > 0 && <div className={styles.searchResults}>{searchResults.map(item => <button type="button" className={styles.searchSelect} key={item.symbol} onClick={() => selectInstrument(item)}><ProductIcon symbol={item.label} category={item.category}/><b>{item.label}</b><span>{locale.startsWith("zh") ? item.nameZh : item.name}</span><small>{t(marketTabs.find(tab => tab[0] === item.category)?.[1] ?? "")}</small></button>)}</div>}<div className={styles.symbolIndex}><span>{t("品种索引")}</span>{marketInstruments.map(item => <div className={`${styles.symbolChip} ${item.symbol === symbol ? styles.active : ""}`} key={item.symbol}><button type="button" className={styles.symbolSelect} onClick={() => selectInstrument(item)}><ProductIcon symbol={item.label} category={item.category}/><span>{item.label}</span></button></div>)}</div></section>
    <section className={styles.instrumentSummary}><div className={styles.instrumentName}><ProductIcon symbol={current?.label || "?"} category={current?.category || "crypto"} className={styles.instrumentMark}/><div><h2>{current?.label || "—"}</h2><p>{locale.startsWith("zh") ? current?.nameZh || current?.name || "" : current?.name || ""}</p></div><em className={quote && quote.changePercent < 0 ? "down" : "up"}>{quote ? `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%` : "—"}</em></div><div className={styles.summaryPrice}><small>{t("当前价格")}</small><b>{price(quote?.price || 0)}</b><span className={quote && quote.change < 0 ? "down" : "up"}>{quote ? `${quote.change >= 0 ? "+" : ""}${price(quote.change)}` : "—"}</span></div><div><small>{t("24H最高")}</small><b>{price(quote?.high || 0)}</b></div><div><small>{t("24H最低")}</small><b>{price(quote?.low || 0)}</b></div><div><small>{t("24H成交量")}</small><b>{compact(quote?.volume || 0)}</b></div><div><small>{t("开盘价")}</small><b>{price(quote?.open || 0)}</b></div></section>
    <section className={styles.terminalChart} ref={chartRef}>
      <header className={styles.chartToolbar}>
        <div className={styles.periodSwitcher}>{periods.map(item => <button key={item} className={period === item ? "active" : ""} onClick={() => selectPeriod(item)}>{item}</button>)}</div>
        <div className={styles.chartTools}>
          <span className={styles.chartSource}>{quote?.source || "Public market data"}</span>
          <span className={styles.refreshRate} data-streaming={marketFeedStatus === "live" || undefined}><i />{marketStreamLabel}</span>
          <button className={styles.historyButton} disabled={loadingHistory || historyExhausted} onClick={() => void loadOlderCandles()}>{t(loadingHistory ? "加载中…" : historyExhausted ? "已到最早" : "← 更早")}</button>
          <button aria-label={t("缩小 K 线")} onClick={() => changeZoom(-.5)}>−</button>
          <button aria-label={t("放大 K 线")} onClick={() => changeZoom(.5)}>＋</button>
          <button onClick={fullscreen}>{t("⛶ 全屏")}</button>
        </div>
      </header>
      {message && <div className={styles.dataMessage}><i />{message}</div>}
      <div className={styles.chartViewport} ref={chartViewportRef} onWheel={event => { event.preventDefault(); changeZoom(event.deltaY < 0 ? .25 : -.25); }} onPointerDown={beginChartDrag} onPointerMove={moveChartDrag} onPointerUp={endChartDrag} onPointerCancel={endChartDrag}>
        {visibleCandles.length ? <div className={styles.chartCanvas} style={{ width: `${Math.max(100, (visibleCandles.length / 160) * zoom * 100)}%` }}>
          <div className={styles.gridLines} />
          <div className={styles.yAxis}>{axis.map(value => <span key={value}>{price(value)}</span>)}</div>
          <div className={styles.ohlcReadout}>{hovered ? <><span>{new Date(hovered.time).toLocaleString(locale)}</span><b>O {price(hovered.open)}</b><b>H {price(hovered.high)}</b><b>L {price(hovered.low)}</b><b>C {price(hovered.close)}</b><em className={hovered.close >= hovered.open ? styles.up : styles.down}>{hovered.close >= hovered.open ? "+" : "−"}{price(Math.abs(hovered.close - hovered.open))}</em></> : <><span>{current?.label} · {period}</span><b>{t("移动鼠标查看 OHLC")}</b></>}</div>
          <div className={styles.candles} style={{ gridTemplateColumns: `repeat(${visibleCandles.length}, minmax(3px, 1fr))` }}>
            {visibleCandles.map((item, index) => {
              const rising = item.close >= item.open;
              const bodyTop = percent(Math.max(item.open, item.close));
              const bodyHeight = Math.max(.7, Math.abs(percent(item.open) - percent(item.close)));
              const wickTop = percent(item.high);
              const wickHeight = Math.max(1, percent(item.low) - wickTop);
              return <div className={`${styles.candle} ${rising ? "" : styles.falling}`} key={`${item.time}-${index}`} onMouseEnter={() => setHovered(item)} onMouseLeave={() => setHovered(null)}>
                <i className={styles.wick} style={{ top: `${wickTop}%`, height: `${wickHeight}%` }} />
                <b className={styles.body} style={{ top: `${bodyTop}%`, height: `${bodyHeight}%` }} />
                <i className={styles.crosshairV} />
                <i className={styles.crosshairH} style={{ top: `${percent(item.close)}%` }} />
              </div>;
            })}
          </div>
          {quote?.price ? <div className={styles.currentPriceLine} style={{ top: `${42 + percent(quote.price) * 3.1}px` }}><span>{price(quote.price)}</span></div> : null}
          <div className={styles.volume} style={{ gridTemplateColumns: `repeat(${visibleCandles.length}, minmax(3px, 1fr))` }}>{visibleCandles.map(item => <i key={`${item.time}-volume`} className={item.close >= item.open ? undefined : styles.falling} style={{ height: `${Math.max(2, (item.volume / maxVisibleVolume) * 100)}%` }} />)}</div>
          <div className={styles.xAxis}>{visibleCandles.filter((_, index) => index % Math.max(1, Math.floor(visibleCandles.length / 7)) === 0).map(item => <span key={item.time}>{candleTimeLabel(item.time, period, locale)}</span>)}</div>
        </div> : <div className={styles.chartEmpty}><b>{t(loading ? "正在连接实时 K 线" : "实时 K 线暂不可用")}</b><span>{message || t("行情源返回后将在此处显示 K 线与成交量")}</span></div>}
      </div>
      <footer className={styles.chartFooter}><span><i className={styles.legendUp} />{t("上涨")}</span><span><i className={styles.legendDown} />{t("下跌")}</span><small>{marketStreamLabel} · {t("左右拖动回看历史 · 拖到左端自动加载更早 K 线")}</small></footer>
    </section>
    <section className={styles.newsFeed}><header><div><span className={styles.eyebrow}>NEWS &amp; EVENTS</span><h2>{t("新闻与事件")}</h2><p>{t("聚合市场快讯、资金流向和平台公告，每 60 秒重新检查来源与内容新鲜度。")}</p></div><span className={newsFreshness === "fresh" ? "market-news-status is-live" : "market-news-status is-fallback"}><i />{newsStatusLabel}{newsObservedAt && <time title={t("最近检查时间")}>{t("检查于")} {new Date(newsObservedAt).toLocaleTimeString(locale)}</time>}</span></header>{newsMessage && <div className={styles.newsMessage}>{newsMessage}</div>}<div className={styles.newsGrid}>{news.length ? news.slice(0, 8).map(item => <NewsCard item={item} t={t} key={item.id} />) : <div className={styles.newsEmpty}><b>{t(newsFreshness === "unavailable" ? "新闻源暂不可用" : "当前没有新闻条目")}</b><span>{t("来源恢复或返回新内容后将在这里自动显示。")}</span></div>}</div></section>
  </div>;
}
