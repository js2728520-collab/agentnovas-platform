"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ProductIcon } from "./coin-icon";

type Market = "crypto" | "forex" | "metals" | "stocks";
type Instrument = { symbol: string; label: string; name: string; nameZh: string; category: Market; providerSymbol: string; aliases: string[] };
type Quote = { price: number; change: number; changePercent: number; high: number; low: number; volume: number; open: number; live: boolean; source: string; updatedAt: string; error?: string };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type NewsItem = { id: string; title: string; summary: string; category: "快讯" | "资金流向" | "公告"; publishedAt: string; source: string; link: string; live: boolean; timeLabel: string };
type WatchlistItem = Instrument & { id: string; createdAt: string };
type ApiResult<T> = { ok: boolean; data: T | null; error: string };

const marketTabs: Array<[Market, string, string]> = [["crypto", "加密货币", "CRYPTO"], ["forex", "外汇", "FOREX"], ["metals", "贵金属", "METALS"], ["stocks", "美股", "US EQUITIES"]];
const periods = ["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W"];
const fallbackInstruments: Instrument[] = [{ symbol: "BTCUSD", label: "BTC/USD", name: "Bitcoin", nameZh: "比特币", category: "crypto", providerSymbol: "BTCUSDT", aliases: ["btc", "bitcoin", "比特币"] }];
const binanceIntervals: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" };
const intervalDurationMs: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000, "1W": 604_800_000 };
const watchlistCopies: Record<string, { heading: string; description: string; refresh: string; loading: string; loginHint: string; signIn: string; empty: string; watchCurrent: string; remove: string; add: string; watched: string; watch: string; connecting: string }> = {
  "zh-CN": { heading: "关注产品", description: "实时跟踪你关注的交易品种", refresh: "每 15 秒更新", loading: "正在读取关注列表…", loginHint: "登录后可跨设备保存关注产品", signIn: "前往登录", empty: "暂无关注产品", watchCurrent: "收藏当前产品", remove: "取消收藏", add: "收藏产品", watched: "已收藏", watch: "收藏", connecting: "行情连接中" },
  "zh-TW": { heading: "關注產品", description: "即時追蹤你關注的交易品種", refresh: "每 15 秒更新", loading: "正在讀取關注列表…", loginHint: "登入後可跨裝置保存關注產品", signIn: "前往登入", empty: "暫無關注產品", watchCurrent: "收藏目前產品", remove: "取消收藏", add: "收藏產品", watched: "已收藏", watch: "收藏", connecting: "行情連接中" },
  "en-US": { heading: "Watchlist", description: "Track saved products with live quotes", refresh: "Updates every 15 seconds", loading: "Loading watchlist…", loginHint: "Sign in to sync your watchlist across devices", signIn: "Sign in", empty: "No watched products", watchCurrent: "Watch current product", remove: "Remove from watchlist", add: "Add to watchlist", watched: "Watched", watch: "Watch", connecting: "Connecting quote" },
  "ru-RU": { heading: "Список наблюдения", description: "Отслеживайте выбранные инструменты в реальном времени", refresh: "Обновление каждые 15 секунд", loading: "Загрузка списка…", loginHint: "Войдите, чтобы синхронизировать список на всех устройствах", signIn: "Войти", empty: "Список наблюдения пуст", watchCurrent: "Добавить текущий инструмент", remove: "Удалить из списка", add: "Добавить в список", watched: "В списке", watch: "Наблюдать", connecting: "Подключение котировки" },
  "es-ES": { heading: "Lista de seguimiento", description: "Sigue tus productos guardados con precios en vivo", refresh: "Actualiza cada 15 segundos", loading: "Cargando lista…", loginHint: "Inicia sesión para sincronizar tu lista entre dispositivos", signIn: "Iniciar sesión", empty: "No hay productos guardados", watchCurrent: "Seguir producto actual", remove: "Quitar de la lista", add: "Añadir a la lista", watched: "En seguimiento", watch: "Seguir", connecting: "Conectando cotización" },
  "ja-JP": { heading: "ウォッチリスト", description: "登録した銘柄をリアルタイム価格で追跡", refresh: "15秒ごとに更新", loading: "ウォッチリストを読み込み中…", loginHint: "ログインするとウォッチリストを端末間で同期できます", signIn: "ログイン", empty: "登録銘柄はありません", watchCurrent: "現在の銘柄を登録", remove: "ウォッチリストから削除", add: "ウォッチリストに追加", watched: "登録済み", watch: "登録", connecting: "価格を接続中" },
  "ko-KR": { heading: "관심 목록", description: "저장한 종목을 실시간 시세로 추적", refresh: "15초마다 업데이트", loading: "관심 목록 불러오는 중…", loginHint: "로그인하면 관심 목록을 기기 간 동기화할 수 있습니다", signIn: "로그인", empty: "관심 종목이 없습니다", watchCurrent: "현재 종목 관심 등록", remove: "관심 목록에서 삭제", add: "관심 목록에 추가", watched: "관심 등록됨", watch: "관심 등록", connecting: "시세 연결 중" },
};

function price(value: number) { if (!value) return "—"; return value < 1 ? value.toFixed(5) : value.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function compact(value: number) { if (!value) return "—"; if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`; if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`; if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`; return value.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function candleTimeLabel(timestamp: number, interval: string) { const date = new Date(timestamp); return interval === "1D" || interval === "1W" ? date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function mergeCandleRows(...groups: Candle[][]) { const rows = new Map<number, Candle>(); groups.flat().forEach(item => rows.set(item.time, item)); return [...rows.values()].sort((a, b) => a.time - b.time).slice(-1500); }
async function apiJson<T>(url: string): Promise<ApiResult<T>> { try { const response = await fetch(url, { cache: "no-store" }); const data = await response.json().catch(() => null) as (T & { error?: string }) | null; return { ok: response.ok && Boolean(data), data, error: response.ok ? "" : data?.error || `接口返回 HTTP ${response.status}` }; } catch (error) { return { ok: false, data: null, error: error instanceof Error ? error.message : "网络连接失败" }; } }

function NewsCard({ item }: { item: NewsItem }) {
  const content = <>
    <header><span>{item.category}</span><time>{item.timeLabel}</time></header>
    <h3>{item.title}</h3>
    <p>{item.summary || "打开原文查看完整内容。"}</p>
    <footer><span>{item.source}</span><b>{item.link ? "查看原文 ↗" : "备用提示"}</b></footer>
  </>;
  return item.link
    ? <a className="market-news-card" href={item.link} target="_blank" rel="noreferrer">{content}</a>
    : <article className="market-news-card is-fallback">{content}</article>;
}

export default function LiveMarket({ onLogin, locale = "zh-CN" }: { onLogin?: () => void; locale?: string }) {
  const [instruments, setInstruments] = useState<Instrument[]>(fallbackInstruments), [market, setMarket] = useState<Market>("crypto"), [symbol, setSymbol] = useState("BTCUSD"), [query, setQuery] = useState(""), [period, setPeriod] = useState("15m"), [quote, setQuote] = useState<Quote | null>(null), [candles, setCandles] = useState<Candle[]>([]), [hovered, setHovered] = useState<Candle | null>(null), [zoom, setZoom] = useState(1), [message, setMessage] = useState(""), [loading, setLoading] = useState(true), [refreshKey, setRefreshKey] = useState(0), [streamState, setStreamState] = useState<"connecting" | "live" | "fallback">("connecting"), [loadingHistory, setLoadingHistory] = useState(false), [historyExhausted, setHistoryExhausted] = useState(false), [news, setNews] = useState<NewsItem[]>([]), [newsMessage, setNewsMessage] = useState(""), [newsLive, setNewsLive] = useState(false), [newsUpdatedAt, setNewsUpdatedAt] = useState("");
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [watchlistStatus, setWatchlistStatus] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [watchlistMessage, setWatchlistMessage] = useState("");
  const [pendingWatchSymbol, setPendingWatchSymbol] = useState("");
  const chartRef = useRef<HTMLElement>(null), chartViewportRef = useRef<HTMLDivElement>(null), dragRef = useRef<{ x: number; scrollLeft: number } | null>(null), historyLoadingRef = useRef(false), needsInitialScrollRef = useRef(true);
  const current = instruments.find(item => item.symbol === symbol) || instruments[0];
  const marketInstruments = useMemo(() => instruments.filter(item => item.category === market), [instruments, market]);
  const searchResults = useMemo(() => { const normalized = query.trim().toLowerCase(); if (!normalized) return []; return instruments.filter(item => [item.symbol, item.label, item.name, item.nameZh, ...item.aliases].join(" ").toLowerCase().includes(normalized)).slice(0, 8); }, [instruments, query]);
  const watchedSymbols = useMemo(() => new Set(watchlist.map(item => item.symbol)), [watchlist]);
  const watchCopy = watchlistCopies[locale] || watchlistCopies["en-US"];
  function selectInstrument(item: Instrument) { setMarket(item.category); setSymbol(item.symbol); setQuery(""); setQuote(null); setCandles([]); setMessage(""); setHistoryExhausted(false); needsInitialScrollRef.current = true; if (typeof window !== "undefined") window.history.replaceState(null, "", `/?page=market&symbol=${encodeURIComponent(item.symbol)}`); }
  function selectMarket(next: Market) { const first = instruments.find(item => item.category === next); if (first) selectInstrument(first); else setMarket(next); }
  function selectPeriod(next: string) { setPeriod(next); setCandles([]); setHovered(null); setHistoryExhausted(false); needsInitialScrollRef.current = true; }
  async function loadWatchlist() {
    try {
      const response = await fetch("/api/market/watchlist", { cache: "no-store" });
      if (response.status === 401) { setWatchlistStatus("signed-out"); setWatchlist([]); return; }
      const payload = await response.json().catch(() => null) as { items?: WatchlistItem[]; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "关注列表读取失败");
      setWatchlist(Array.isArray(payload?.items) ? payload.items : []);
      setWatchlistStatus("ready");
    } catch (error) {
      setWatchlistStatus("error");
      setWatchlistMessage(error instanceof Error ? error.message : "关注列表读取失败");
    }
  }
  async function toggleWatchlist(item: Instrument) {
    if (watchlistStatus === "signed-out") { onLogin?.(); return; }
    if (pendingWatchSymbol) return;
    const followed = watchedSymbols.has(item.symbol);
    setPendingWatchSymbol(item.symbol);
    setWatchlistMessage("");
    try {
      const response = await fetch("/api/market/watchlist", { method: followed ? "DELETE" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: item.symbol, category: item.category }) });
      const payload = await response.json().catch(() => null) as { item?: WatchlistItem; error?: string; message?: string } | null;
      if (response.status === 401) { setWatchlistStatus("signed-out"); onLogin?.(); return; }
      if (!response.ok) throw new Error(payload?.error || "关注操作失败");
      if (followed) {
        setWatchlist(previous => previous.filter(row => row.symbol !== item.symbol));
      } else if (payload?.item) setWatchlist(previous => [payload.item!, ...previous.filter(row => row.symbol !== item.symbol)]);
      setWatchlistStatus("ready");
    } catch (error) { setWatchlistMessage(error instanceof Error ? error.message : "关注操作失败"); }
    finally { setPendingWatchSymbol(""); }
  }
  useEffect(() => { fetch("/api/market/instruments", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then(data => { const rows = Array.isArray(data?.instruments) ? data.instruments as Instrument[] : fallbackInstruments; setInstruments(rows); const urlSymbol = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("symbol")?.toUpperCase().replace("/", "") : ""; const requested = rows.find(item => item.symbol === urlSymbol); if (requested) { setMarket(requested.category); setSymbol(requested.symbol); } }).catch(() => setInstruments(fallbackInstruments)); }, []);
  useEffect(() => { const timer = window.setTimeout(() => void loadWatchlist(), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => { if (!current) return; let active = true, inFlight = false; const load = async () => { if (inFlight) return; inFlight = true; if (active) setLoading(true); const [quoteResult, candleResult] = await Promise.all([apiJson<Quote>(`/api/market/quote?symbol=${encodeURIComponent(current.symbol)}&category=${current.category}`), apiJson<{ candles?: Candle[]; error?: string }>(`/api/market/candles?symbol=${encodeURIComponent(current.symbol)}&category=${current.category}&interval=${period}`)]); if (active) { if (quoteResult.ok && quoteResult.data) setQuote(quoteResult.data); if (candleResult.ok && candleResult.data) { const incoming = candleResult.data.candles || []; setCandles(previous => previous.length ? mergeCandleRows(previous, incoming) : incoming); } setMessage([quoteResult.error, candleResult.error].filter(Boolean).join("；")); setLoading(false); } inFlight = false; }; void load(); const delay = current.category === "crypto" && streamState === "live" ? 15_000 : 1_000; const timer = window.setInterval(() => void load(), delay); return () => { active = false; window.clearInterval(timer); }; }, [current, period, refreshKey, streamState]);
  useEffect(() => {
    if (!current || current.category !== "crypto") return;
    let socket: WebSocket | null = null, retryTimer: number | undefined, stopped = false;
    let latestTrade: { price: number; tradeTime: number; eventTime: number } | null = null;
    const frame = window.requestAnimationFrame(() => setStreamState("connecting"));
    const streamSymbol = current.providerSymbol.toLowerCase();
    const streamInterval = binanceIntervals[period] || "15m";
    const renderTimer = window.setInterval(() => {
      const trade = latestTrade;
      if (!trade) return;
      latestTrade = null;
      setQuote(previous => previous ? { ...previous, price: trade.price, live: true, updatedAt: new Date(trade.eventTime).toISOString() } : previous);
      setCandles(previous => {
        const last = previous.at(-1);
        if (!last || trade.tradeTime < last.time || trade.tradeTime >= last.time + (intervalDurationMs[period] || 900_000)) return previous;
        const updated = { ...last, close: trade.price, high: Math.max(last.high, trade.price), low: Math.min(last.low, trade.price) };
        return [...previous.slice(0, -1), updated];
      });
    }, 100);
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(`wss://data-stream.binance.vision/stream?streams=${streamSymbol}@aggTrade/${streamSymbol}@kline_${streamInterval}`);
      socket.onopen = () => setStreamState("live");
      socket.onmessage = event => {
        try {
          const payload = JSON.parse(String(event.data)) as { data?: { e?: string; E?: number; p?: string; T?: number; k?: { t: number; o: string; h: string; l: string; c: string; v: string } } };
          const data = payload.data;
          if (!data) return;
          if (data.e === "aggTrade") {
            const livePrice = Number(data.p);
            const tradeTime = Number(data.T || data.E || Date.now());
            if (!Number.isFinite(livePrice) || livePrice <= 0) return;
            latestTrade = { price: livePrice, tradeTime, eventTime: Number(data.E || Date.now()) };
            return;
          }
          if (data.e === "kline" && data.k) {
            const nextCandle = { time: Number(data.k.t), open: Number(data.k.o), high: Number(data.k.h), low: Number(data.k.l), close: Number(data.k.c), volume: Number(data.k.v) };
            if (Object.values(nextCandle).some(value => !Number.isFinite(value))) return;
            setCandles(previous => {
              const existingIndex = previous.findIndex(item => item.time === nextCandle.time);
              if (existingIndex < 0) return mergeCandleRows(previous, [nextCandle]);
              const next = previous.slice();
              next[existingIndex] = nextCandle;
              return next;
            });
            setQuote(previous => previous ? { ...previous, price: nextCandle.close, live: true, updatedAt: new Date(data.E || Date.now()).toISOString() } : previous);
          }
        } catch {
          // Ignore malformed stream frames and wait for the next market event.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => { if (!stopped) { setStreamState("fallback"); retryTimer = window.setTimeout(connect, 2_000); } };
    };
    connect();
    return () => { stopped = true; window.cancelAnimationFrame(frame); window.clearInterval(renderTimer); if (retryTimer) window.clearTimeout(retryTimer); socket?.close(); };
  }, [current, period]);
  useEffect(() => { if (!current) return; let active = true; const coin = current.symbol.replace(/USD$/, ""); const load = async () => { const result = await apiJson<{ items?: NewsItem[]; live?: boolean; updatedAt?: string; error?: string }>(`/api/market/news?coin=${encodeURIComponent(coin)}`); if (!active) return; setNews(result.data?.items || []); setNewsLive(Boolean(result.data?.live)); setNewsUpdatedAt(result.data?.updatedAt || ""); setNewsMessage(result.error || (!result.data?.live ? "实时新闻源暂时不可用，当前显示备用提示。" : "")); }; void load(); const timer = window.setInterval(() => void load(), 60_000); return () => { active = false; window.clearInterval(timer); }; }, [current, refreshKey]);
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
    const result = await apiJson<{ candles?: Candle[]; hasMore?: boolean; error?: string }>(`/api/market/candles?symbol=${encodeURIComponent(current.symbol)}&category=${current.category}&interval=${period}&before=${oldestTime}&limit=500`);
    const olderRows = result.data?.candles || [];
    if (result.ok && olderRows.length) {
      setCandles(previous => mergeCandleRows(olderRows, previous));
      setHistoryExhausted(result.data?.hasMore === false || olderRows.every(item => candles.some(existing => existing.time === item.time)));
      window.requestAnimationFrame(() => { const nextViewport = chartViewportRef.current; if (nextViewport) nextViewport.scrollLeft += Math.max(0, nextViewport.scrollWidth - oldScrollWidth); });
    } else if (result.ok) setHistoryExhausted(true);
    historyLoadingRef.current = false;
    setLoadingHistory(false);
  }

  return <div className="market-terminal-page"><div className="market-terminal-title"><div><h1>行情中心</h1><p>覆盖加密货币、外汇、贵金属及美股市场</p></div><div className="market-title-actions"><button type="button" onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>{loading ? "更新中…" : "立即刷新"}</button><span className={quote?.live ? "market-live-status" : "market-offline-status"}><i />{quote?.live ? "实时行情" : loading ? "正在连接" : "行情源待连接"}{quote?.updatedAt && <time>{new Date(quote.updatedAt).toLocaleTimeString("zh-CN")}</time>}</span></div></div>
    <nav className="market-category-tabs" aria-label="市场分类">{marketTabs.map(([key, label, code]) => <button key={key} className={market === key ? "active" : ""} onClick={() => selectMarket(key)}><span>{label}</span><small>{code}</small></button>)}</nav>
    <section className="market-watchlist-panel">
      <header><h2>{watchCopy.heading}</h2>{current && <button type="button" className={`market-watch-current ${watchedSymbols.has(current.symbol) ? "active" : ""}`} disabled={watchlistStatus === "loading" || pendingWatchSymbol === current.symbol} onClick={() => void toggleWatchlist(current)} title={watchedSymbols.has(current.symbol) ? watchCopy.remove : watchCopy.add}>{watchedSymbols.has(current.symbol) ? `★ ${watchCopy.watched}` : `☆ ${watchCopy.watch}`}</button>}</header>
      <div className="market-watchlist-content">
        {watchlistStatus === "loading" ? <div className="market-watchlist-empty"><b>{watchCopy.loading}</b></div>
          : watchlistStatus === "signed-out" ? <div className="market-watchlist-empty"><span>{watchCopy.loginHint}</span><button type="button" onClick={onLogin}>{watchCopy.signIn}</button></div>
            : watchlist.length ? <div className="market-watchlist-cards">{watchlist.map(item => <article key={item.symbol} className={item.symbol === symbol ? "active" : ""}><button type="button" className="market-watchlist-select" onClick={() => selectInstrument(item)}><ProductIcon symbol={item.label} category={item.category}/><b>{item.label}</b></button><button type="button" className="market-watchlist-remove" aria-label={`${watchCopy.remove} ${item.label}`} title={watchCopy.remove} disabled={pendingWatchSymbol === item.symbol} onClick={() => void toggleWatchlist(item)}>★</button></article>)}</div>
              : <div className="market-watchlist-empty"><span>{watchCopy.empty}</span>{current && <button type="button" onClick={() => void toggleWatchlist(current)}>☆ {watchCopy.watchCurrent}</button>}</div>}
      </div>
      {watchlistMessage && <p className="market-watchlist-message" role="status">{watchlistMessage}</p>}
    </section>
    <section className="market-selector-panel"><label className="market-search-box"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索交易品种 / Symbol / 名称" aria-label="搜索交易品种"/><kbd>⌘ K</kbd></label>{searchResults.length > 0 && <div className="market-search-results">{searchResults.map(item => <div className="market-search-result-row" key={item.symbol}><button type="button" className="market-search-select" onClick={() => selectInstrument(item)}><ProductIcon symbol={item.label} category={item.category}/><b>{item.label}</b><span>{item.name} · {item.nameZh}</span><small>{marketTabs.find(tab => tab[0] === item.category)?.[1]}</small></button><button type="button" className={`market-search-follow ${watchedSymbols.has(item.symbol) ? "active" : ""}`} aria-label={`${watchedSymbols.has(item.symbol) ? watchCopy.remove : watchCopy.add} ${item.label}`} disabled={pendingWatchSymbol === item.symbol} onClick={() => void toggleWatchlist(item)}>{watchedSymbols.has(item.symbol) ? "★" : "☆"}</button></div>)}</div>}<div className="market-symbol-index"><span>品种索引</span>{marketInstruments.map(item => <div className={`market-symbol-chip ${item.symbol === symbol ? "active" : ""}`} key={item.symbol}><button type="button" className="market-symbol-select" onClick={() => selectInstrument(item)}><ProductIcon symbol={item.label} category={item.category}/><span>{item.label}</span></button><button type="button" className={`market-symbol-follow ${watchedSymbols.has(item.symbol) ? "active" : ""}`} aria-label={`${watchedSymbols.has(item.symbol) ? watchCopy.remove : watchCopy.add} ${item.label}`} title={watchedSymbols.has(item.symbol) ? watchCopy.remove : watchCopy.add} disabled={pendingWatchSymbol === item.symbol} onClick={() => void toggleWatchlist(item)}>{watchedSymbols.has(item.symbol) ? "★" : "☆"}</button></div>)}</div></section>
    <section className="market-instrument-summary"><div className="market-instrument-name"><ProductIcon symbol={current?.label || "?"} category={current?.category || "crypto"} className="instrument-mark"/><div><h2>{current?.label || "—"}</h2><p>{current?.name || ""} / {current?.nameZh || ""}</p></div><div className="market-instrument-actions">{current && <button type="button" className={watchedSymbols.has(current.symbol) ? "active" : ""} disabled={pendingWatchSymbol === current.symbol} onClick={() => void toggleWatchlist(current)} title={watchedSymbols.has(current.symbol) ? watchCopy.remove : watchCopy.add}>{watchedSymbols.has(current.symbol) ? `★ ${watchCopy.watched}` : `☆ ${watchCopy.watch}`}</button>}<em className={quote && quote.changePercent < 0 ? "down" : "up"}>{quote ? `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%` : "—"}</em></div></div><div className="market-summary-price"><small>当前价格</small><b>{price(quote?.price || 0)}</b><span className={quote && quote.change < 0 ? "down" : "up"}>{quote ? `${quote.change >= 0 ? "+" : ""}${price(quote.change)}` : "—"}</span></div><div><small>24H最高</small><b>{price(quote?.high || 0)}</b></div><div><small>24H最低</small><b>{price(quote?.low || 0)}</b></div><div><small>24H成交量</small><b>{compact(quote?.volume || 0)}</b></div><div><small>开盘价</small><b>{price(quote?.open || 0)}</b></div></section>
    <section className="market-terminal-chart" ref={chartRef}>
      <header className="market-chart-toolbar">
        <div className="period-switcher">{periods.map(item => <button key={item} className={period === item ? "active" : ""} onClick={() => selectPeriod(item)}>{item}</button>)}</div>
        <div className="chart-tools">
          <span className="chart-source">{quote?.source || "Public market data"}</span>
          <span className={`chart-refresh-rate ${current?.category === "crypto" && streamState === "live" ? "is-streaming" : ""}`}><i />{current?.category === "crypto" && streamState === "live" ? "0.1 秒实时" : "1 秒轮询"}</span>
          <button className="chart-history-button" disabled={loadingHistory || historyExhausted} onClick={() => void loadOlderCandles()}>{loadingHistory ? "加载中…" : historyExhausted ? "已到最早" : "← 更早"}</button>
          <button aria-label="缩小 K 线" onClick={() => changeZoom(-.5)}>−</button>
          <button aria-label="放大 K 线" onClick={() => changeZoom(.5)}>＋</button>
          <button onClick={fullscreen}>⛶ 全屏</button>
        </div>
      </header>
      {message && <div className="market-data-message"><i />{message}</div>}
      <div className="market-chart-viewport" ref={chartViewportRef} onWheel={event => { event.preventDefault(); changeZoom(event.deltaY < 0 ? .25 : -.25); }} onPointerDown={beginChartDrag} onPointerMove={moveChartDrag} onPointerUp={endChartDrag} onPointerCancel={endChartDrag}>
        {visibleCandles.length ? <div className="market-chart-canvas" style={{ width: `${Math.max(100, (visibleCandles.length / 160) * zoom * 100)}%` }}>
          <div className="chart-grid-lines" />
          <div className="chart-y-axis">{axis.map(value => <span key={value}>{price(value)}</span>)}</div>
          <div className="chart-ohlc-readout">{hovered ? <><span>{new Date(hovered.time).toLocaleString("zh-CN")}</span><b>O {price(hovered.open)}</b><b>H {price(hovered.high)}</b><b>L {price(hovered.low)}</b><b>C {price(hovered.close)}</b><em className={hovered.close >= hovered.open ? "up" : "down"}>{hovered.close >= hovered.open ? "+" : "−"}{price(Math.abs(hovered.close - hovered.open))}</em></> : <><span>{current?.label} · {period}</span><b>移动鼠标查看 OHLC</b></>}</div>
          <div className="chart-candles" style={{ gridTemplateColumns: `repeat(${visibleCandles.length}, minmax(3px, 1fr))` }}>
            {visibleCandles.map((item, index) => {
              const rising = item.close >= item.open;
              const bodyTop = percent(Math.max(item.open, item.close));
              const bodyHeight = Math.max(.7, Math.abs(percent(item.open) - percent(item.close)));
              const wickTop = percent(item.high);
              const wickHeight = Math.max(1, percent(item.low) - wickTop);
              return <div className={`chart-candle ${rising ? "rising" : "falling"} ${index === visibleCandles.length - 1 ? "latest" : ""}`} key={`${item.time}-${index}`} onMouseEnter={() => setHovered(item)} onMouseLeave={() => setHovered(null)}>
                <i className="candle-wick" style={{ top: `${wickTop}%`, height: `${wickHeight}%` }} />
                <b className="candle-body" style={{ top: `${bodyTop}%`, height: `${bodyHeight}%` }} />
                <i className="crosshair-v" />
                <i className="crosshair-h" style={{ top: `${percent(item.close)}%` }} />
              </div>;
            })}
          </div>
          {quote?.price ? <div className="current-price-line" style={{ top: `${42 + percent(quote.price) * 3.1}px` }}><span>{price(quote.price)}</span></div> : null}
          <div className="chart-volume" style={{ gridTemplateColumns: `repeat(${visibleCandles.length}, minmax(3px, 1fr))` }}>{visibleCandles.map(item => <i key={`${item.time}-volume`} className={item.close >= item.open ? "rising" : "falling"} style={{ height: `${Math.max(2, (item.volume / maxVisibleVolume) * 100)}%` }} />)}</div>
          <div className="chart-x-axis">{visibleCandles.filter((_, index) => index % Math.max(1, Math.floor(visibleCandles.length / 7)) === 0).map(item => <span key={item.time}>{candleTimeLabel(item.time, period)}</span>)}</div>
        </div> : <div className="market-chart-empty"><b>{loading ? "正在连接实时 K 线" : "实时 K 线暂不可用"}</b><span>{message || "行情源返回后将在此处显示 K 线与成交量"}</span></div>}
      </div>
      <footer className="market-chart-footer"><span><i className="legend-up" />上涨</span><span><i className="legend-down" />下跌</span><small>{current?.category === "crypto" && streamState === "live" ? "Binance 成交流每 0.1 秒刷新画面" : "每 1 秒更新"} · 左右拖动回看历史 · 拖到左端自动加载更早 K 线</small></footer>
    </section>
    <section className="market-news-feed"><header><div><span className="eyebrow">LIVE NEWS &amp; EVENTS</span><h2>新闻与事件</h2><p>聚合市场快讯、资金流向和平台公告，每 60 秒自动更新。</p></div><span className={newsLive ? "market-news-status is-live" : "market-news-status is-fallback"}><i />{newsLive ? "实时更新" : "备用模式"}{newsUpdatedAt && <time>{new Date(newsUpdatedAt).toLocaleTimeString("zh-CN")}</time>}</span></header>{newsMessage && <div className="market-news-message">{newsMessage}</div>}<div className="market-news-grid">{news.length ? news.slice(0, 8).map(item => <NewsCard item={item} key={item.id} />) : <div className="market-news-empty"><b>正在连接新闻源</b><span>新闻与事件返回后将在这里自动显示。</span></div>}</div></section>
  </div>;
}
