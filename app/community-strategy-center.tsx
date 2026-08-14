"use client";

import { useEffect, useState } from "react";
import type { StrategyDetailData } from "./strategy-detail";

type Row = Record<string, unknown>;
type ChatMessage = { role: "user" | "assistant"; text: string };
type Studio = {
  name: string;
  symbol: string;
  period: string;
  style: string;
  risk: "low" | "medium" | "high";
  capital: string;
  stopLoss: string;
  takeProfit: string;
  maxDrawdown: string;
  indicators: string;
  entryRule: string;
  exitRule: string;
  riskRule: string;
};
type BacktestResult = {
  status?: string;
  sampleSize?: number;
  netReturnPct?: number;
  maxDrawdownPct?: number;
  winRatePct?: number;
  feesUsdt?: number;
  slippageUsdt?: number;
  evidenceRef?: string;
  provider?: string;
};

const initial: Studio = {
  name: "",
  symbol: "BTC/USDT",
  period: "15m",
  style: "趋势跟随",
  risk: "medium",
  capital: "5",
  stopLoss: "2.0",
  takeProfit: "4.0",
  maxDrawdown: "12",
  indicators: "EMA20, EMA60, ADX14, ATR14",
  entryRule: "",
  exitRule: "",
  riskRule: "",
};

type FactorPreset = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  defaults: Partial<Studio>;
};

// These are deliberately conservative, well-known building blocks. They are
// suggestions for research, never promises of returns or ready-made advice.
const factorPresets: FactorPreset[] = [
  {
    id: "trend",
    title: "趋势跟随",
    summary: "适合有方向的行情，减少震荡期追单。",
    tags: ["EMA20/60", "ADX14", "ATR14"],
    defaults: {
      style: "趋势跟随",
      period: "4h",
      indicators: "EMA20, EMA60, ADX14, ATR14, 成交量MA20",
      entryRule: "EMA20 上穿 EMA60 且 ADX14 ≥ 22，收盘确认后入场；成交量不低于 MA20 的 85%。",
      exitRule: "EMA20 下穿 EMA60，或触发 2×ATR14 移动止损；不在单根异常长K线追单。",
      riskRule: "单笔风险 ≤ 0.5%，连续 3 笔亏损暂停 4 个周期；单日亏损达到 2% 停止开仓。",
    },
  },
  {
    id: "range",
    title: "区间反转",
    summary: "适合横盘市场，要求先过滤趋势行情。",
    tags: ["RSI14", "布林20/2", "ATR14"],
    defaults: {
      style: "区间交易",
      period: "1h",
      indicators: "RSI14, Bollinger20(2), ATR14, ADX14",
      entryRule: "ADX14 < 20 且价格触及布林带外轨；RSI14 < 30 做多、> 70 做空，下一根K线确认。",
      exitRule: "回到布林中轨分批止盈；RSI14 回到 50 或触发 1.5×ATR14 止损即退出。",
      riskRule: "单笔风险 ≤ 0.35%，同方向最多 1 个仓位；ADX14 ≥ 25 时暂停区间策略。",
    },
  },
  {
    id: "breakout",
    title: "突破动量",
    summary: "只在波动扩张和成交量确认时参与突破。",
    tags: ["Donchian20", "Volume", "ATR14"],
    defaults: {
      style: "突破动量",
      period: "1h",
      indicators: "Donchian20, Volume/MA20, ATR14, EMA20",
      entryRule: "收盘突破 Donchian20 上轨，成交量 ≥ MA20 的 1.5 倍，且 ATR14 处于过去 50 根的中位数以上。",
      exitRule: "跌回突破区间内退出；达到 3×ATR14 或移动止损后分批平仓。",
      riskRule: "单笔风险 ≤ 0.4%，突破后 2 根K线未延续则撤退；连续 2 次假突破暂停。",
    },
  },
  {
    id: "defensive",
    title: "防守轮动",
    summary: "优先控制回撤，适合低频组合研究。",
    tags: ["EMA120", "波动率", "相关性"],
    defaults: {
      style: "市场中性",
      period: "1D",
      indicators: "EMA120, ATR14, 20日波动率, 相关性过滤",
      entryRule: "价格位于 EMA120 上方且 20 日波动率低于阈值；通过相关性过滤后按等风险分配。",
      exitRule: "收盘跌破 EMA120 或波动率超过上限时减仓至 0；不使用追涨加仓。",
      riskRule: "单笔风险 ≤ 0.25%，总资金使用率 ≤ 30%，账户回撤达到 8% 进入保护模式。",
    },
  },
];

const quickPrompts = [
  "我是新手，请用稳健的 BTC 趋势模板引导我",
  "我想做震荡行情，帮我确认 RSI 和布林带参数",
  "请检查我的止损、止盈和最大回撤是否互相矛盾",
];

const demos: Row[] = [
  ["BTC 趋势守望", "BTC/USDT", 94.8],
  ["ETH 波段均衡", "ETH/USDT", 92.6],
  ["主流币市场中性", "BTC · ETH", 90.4],
  ["SOL 动量捕捉", "SOL/USDT", 88.9],
  ["BNB 区间增强", "BNB/USDT", 86.7],
  ["XRP 流动性观察", "XRP/USDT", 84.3],
  ["多币种低波组合", "BTC · ETH · BNB", 82.8],
  ["DOGE 情绪反转", "DOGE/USDT", 79.6],
  ["LINK 趋势接力", "LINK/USDT", 77.4],
  ["ADA 防守轮动", "ADA/USDT", 75.9],
].map((item, index) => ({
  id: `demo-${index}`,
  name: item[0],
  summary: "趋势、成交量和波动率联合过滤，并设置明确的仓位与退出条件。",
  riskLevel: index === 3 || index === 7 ? "high" : index === 2 || index === 6 || index === 9 ? "low" : "medium",
  symbols: [item[1]],
  version: 1,
  rankingScore: item[2],
  activeFollowers: 0,
  backtests: [],
  demo: true,
}));

function safeJson<T>(raw: string): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function toStrategyDetail(row: Row): StrategyDetailData {
  const backtests = (row.backtests || []) as Row[];
  const currentVersion = Number(row.version || 1);
  const report = backtests.find((item) =>
    item.strategyVersion === currentVersion && item.kind === "backtest",
  );
  return {
    id: String(row.id),
    name: String(row.name || "未命名策略"),
    summary: String(row.summary || "策略规则与风险边界已记录"),
    riskLevel: row.riskLevel === "high" ? "high" : row.riskLevel === "low" ? "low" : "medium",
    symbols: (row.symbols || []) as string[],
    version: currentVersion,
    rankingScore: Number(row.rankingScore || 0),
    activeFollowers: Number(row.activeFollowers || 0),
    publishedAt: row.publishedAt ? String(row.publishedAt) : undefined,
    authorEmail: row.authorEmail ? String(row.authorEmail) : undefined,
    source: "community",
    netReturnPct: report?.netReturnPct == null ? undefined : Number(report.netReturnPct),
    maxDrawdownPct: report?.maxDrawdownPct == null ? undefined : Number(report.maxDrawdownPct),
    winRatePct: report?.winRatePct == null ? undefined : Number(report.winRatePct),
    sampleSize: report?.sampleSize == null ? undefined : Number(report.sampleSize),
  };
}

function backtestFor(row: Row) {
  const version = Number(row.version || 1);
  return ((row.backtests || []) as Row[]).find((item) =>
    item.kind === "backtest" &&
    item.source === "platform_engine" &&
    Number(item.strategyVersion || 1) === version,
  );
}

function riskName(value: unknown) {
  return value === "high" ? "高风险" : value === "low" ? "低风险" : "中风险";
}

export default function CommunityStrategyCenter({
  view = "market",
  onOpenStrategy,
}: {
  view?: "market" | "mine";
  onOpenStrategy?: (strategy: StrategyDetailData) => void;
}) {
  const [rows, setRows] = useState<Row[]>(demos);
  const [mine, setMine] = useState<Row[]>([]);
  const [screen, setScreen] = useState<"list" | "create">("list");
  const [message, setMessage] = useState("");
  const [studio, setStudio] = useState<Studio>(initial);
  const [preferences, setPreferences] = useState({
    goal: "稳健增长",
    experience: "刚开始研究",
    marketCondition: "趋势与震荡都要过滤",
    frequency: "中频（1小时至4小时）",
  });
  const [prompt, setPrompt] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([{
    role: "assistant",
    text: "我会先了解你的目标、经验和市场偏好，再把想法拆成可回测的入场、退出、仓位与熔断条件。你可以先点击一个成熟模板，也可以直接告诉我你的交易想法。",
  }]);
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState("");
  const [draftId, setDraftId] = useState("");
  const [draftVersion, setDraftVersion] = useState(0);
  const [savedSignature, setSavedSignature] = useState("");
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);

  async function load() {
    try {
      const response = await fetch("/api/strategy-marketplace", { cache: "no-store" });
      const raw = await response.text();
      const result = safeJson<{ published?: Row[]; mine?: Row[]; error?: string }>(raw);
      if (!response.ok || !result) return;
      setRows(result.published?.length ? result.published : demos);
      setMine(result.mine || []);
    } catch {
      // 未登录时仍可浏览明确标注的版面样例，但不会伪造“我的策略”。
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function payload() {
    return {
      name: studio.name.trim(),
      summary: `${studio.style} · ${studio.period} · 单次资金上限 ${studio.capital}% · 止损 ${studio.stopLoss}% · 止盈 ${studio.takeProfit}%`,
      symbols: [studio.symbol],
      riskLevel: studio.risk,
      conversation: chat,
      specification: { ...studio, ...preferences },
    };
  }

  function applyPreset(preset: FactorPreset) {
    setStudio((current) => ({ ...current, ...preset.defaults }));
    setGenerated(false);
    setBacktest(null);
    setMessage(`已载入“${preset.title}”研究模板。请结合自己的交易目标修改规则，再向 AI 研究员确认。`);
  }

  const qualityChecks = [
    { label: "交易对与信号周期", ok: Boolean(studio.symbol && studio.period) },
    { label: "入场与退出条件", ok: Boolean(studio.entryRule.trim() && studio.exitRule.trim()) },
    { label: "仓位、止损与最大回撤", ok: Boolean(studio.capital && studio.stopLoss && studio.maxDrawdown) },
    { label: "成熟因子已选择", ok: studio.indicators.split(",").map((item) => item.trim()).filter(Boolean).length >= 2 },
  ];
  const qualityWarnings = [
    Number(studio.stopLoss) >= Number(studio.maxDrawdown) ? "止损不应大于或等于账户最大回撤。" : "",
    Number(studio.capital) > 10 ? "单次资金上限偏高，建议先控制在 5% 以内。" : "",
    !studio.riskRule.trim() ? "建议补充连续亏损暂停和单日熔断条件。" : "",
  ].filter(Boolean);

  async function ensureDraft() {
    if (!studio.name.trim()) throw new Error("请先填写策略名称");
    const body = payload();
    const signature = JSON.stringify(body);
    if (draftId && signature === savedSignature) return { id: draftId, version: draftVersion };
    const endpoint = draftId ? `/api/strategy-marketplace/${draftId}` : "/api/strategy-marketplace";
    const response = await fetch(endpoint, {
      method: draftId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    const result = safeJson<{ id?: string; version?: number; error?: string }>(raw);
    if (!response.ok || !result?.id) throw new Error(result?.error || "策略草稿保存失败");
    const version = Number(result.version || 1);
    setDraftId(result.id);
    setDraftVersion(version);
    setSavedSignature(signature);
    setBacktest(null);
    return { id: result.id, version };
  }

  async function ask() {
    const text = prompt.trim();
    if (!text || busy) return;
    const previous = chat;
    setChat((items) => [...items, { role: "user", text }]);
    setPrompt("");
    setBusy("chat");
    try {
      const response = await fetch("/api/strategy-studio/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversation: previous, specification: studio }),
      });
      const raw = await response.text();
      const result = safeJson<{ text?: string; mode?: string; error?: string }>(raw);
      if (!response.ok || !result?.text) throw new Error(result?.error || "策略研究服务暂不可用");
      setChat((items) => [...items, {
        role: "assistant",
        text: `${result.text}${result.mode === "guided_rules" ? "（当前为平台规则引导模式）" : ""}`,
      }]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "策略研究服务暂不可用");
    } finally {
      setBusy("");
    }
  }

  function generate() {
    if (!chat.some((item) => item.role === "user")) {
      setMessage("请先向策略研究 Agent 说明你的策略想法");
      return;
    }
    if (qualityChecks.filter((item) => !item.ok).length > 0) {
      setMessage("还有关键规则没有补齐。请先处理回测前检查中的待完善项，避免生成无法验证的策略。");
      return;
    }
    if (qualityWarnings.length) {
      setMessage(`已生成候选规则，但请先确认：${qualityWarnings.join(" ")}`);
    }
    setGenerated(true);
    setBacktest(null);
    if (!qualityWarnings.length) setMessage("候选规则已结构化。保存草稿后即可使用真实历史行情回测。");
  }

  async function runBacktest(id: string) {
    setBusy(`backtest:${id}`);
    setMessage("正在获取历史K线并计算手续费、滑点和回撤…");
    try {
      const response = await fetch(`/api/strategy-marketplace/${id}/backtest`, {
        method: "POST",
      });
      const raw = await response.text();
      const result = safeJson<{ message?: string; error?: string; result?: BacktestResult }>(raw);
      if (!response.ok || !result) throw new Error(result?.error || "回测服务没有返回有效结果");
      setMessage(result.message || "回测完成");
      setBacktest(result.result || null);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回测失败");
    } finally {
      setBusy("");
    }
  }

  async function runDraftBacktest() {
    if (!generated) {
      setMessage("请先生成结构化策略规则");
      return;
    }
    try {
      const draft = await ensureDraft();
      await runBacktest(draft.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法保存策略草稿");
    }
  }

  async function save() {
    if (!generated) {
      setMessage("请先完成对话并生成结构化策略规则");
      return;
    }
    setBusy("save");
    try {
      await ensureDraft();
      await load();
      setScreen("list");
      setMessage("策略已真实保存到“我的策略”");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "策略保存失败");
    } finally {
      setBusy("");
    }
  }

  async function submit(id: string) {
    setBusy(`submit:${id}`);
    try {
      const response = await fetch(`/api/strategy-marketplace/${id}/submit`, { method: "POST" });
      const raw = await response.text();
      const result = safeJson<{ message?: string; error?: string }>(raw);
      setMessage(result?.message || result?.error || "提交审核失败");
      if (response.ok) await load();
    } catch {
      setMessage("提交审核失败，请检查网络和登录状态");
    } finally {
      setBusy("");
    }
  }

  function resetStudio() {
    setStudio(initial);
    setPreferences({ goal: "稳健增长", experience: "刚开始研究", marketCondition: "趋势与震荡都要过滤", frequency: "中频（1小时至4小时）" });
    setGenerated(false);
    setBacktest(null);
    setDraftId("");
    setDraftVersion(0);
    setSavedSignature("");
    setMessage("");
    setChat([{
      role: "assistant",
      text: "我会先了解你的目标、经验和市场偏好，再把想法拆成可回测的入场、退出、仓位与熔断条件。你可以先点击一个成熟模板，也可以直接告诉我你的交易想法。",
    }]);
    setScreen("create");
  }

  if (view === "mine" && screen === "create") {
    return <div className="strategy-studio-page">
      <header>
        <button onClick={() => setScreen("list")}>← 返回我的策略</button>
        <div><small>AI STRATEGY LAB</small><h2>创建策略</h2><p>专业引导、真实历史回测、模拟盘测试和平台人工审核。</p></div>
        <span>{draftId ? `草稿 V${draftVersion}` : "尚未保存"}</span>
      </header>
      {message && <div className="notice">{message}</div>}
      <div className="studio-layout">
        <section className="strategy-chat-panel">
          <div className="studio-panel-title"><b>AI 策略研究员</b><span><i />{busy === "chat" ? "思考中" : "在线"}</span></div>
          <div className="studio-research-brief">
            <strong>先问清楚，再生成规则</strong>
            <p>研究员会把你的想法拆成可验证的入场、退出、仓位和熔断条件；不承诺收益，也不会用虚构数据替代回测。</p>
            <div className="studio-quick-prompts">{quickPrompts.map((item) => <button type="button" key={item} onClick={() => setPrompt(item)}>{item}</button>)}</div>
          </div>
          <div className="studio-chat-log">{chat.map((item, index) => <div className={item.role === "assistant" ? "ai" : "user"} key={`${item.role}-${index}`}><b>{item.role === "assistant" ? "策略研究 Agent" : "我"}</b><p>{item.text}</p></div>)}</div>
          <div className="studio-prompt"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：BTC 15分钟趋势策略，震荡行情不交易，最大回撤不超过12%……" /><button disabled={busy === "chat"} onClick={() => void ask()}>发送</button></div>
        </section>
        <aside className="strategy-parameter-panel">
          <div className="studio-panel-title"><b>策略指标与参数</b><span>硬边界辅助</span></div>
          <section className="studio-survey">
            <div className="studio-card-heading"><b>策略需求问卷</b><small>帮助 AI 少猜测</small></div>
            <label>主要目标<select value={preferences.goal} onChange={(event) => setPreferences({ ...preferences, goal: event.target.value })}><option>稳健增长</option><option>趋势捕捉</option><option>降低回撤</option><option>震荡套利</option></select></label>
            <label>研究经验<select value={preferences.experience} onChange={(event) => setPreferences({ ...preferences, experience: event.target.value })}><option>刚开始研究</option><option>有回测经验</option><option>熟悉量化交易</option></select></label>
            <label>希望的交易频率<select value={preferences.frequency} onChange={(event) => setPreferences({ ...preferences, frequency: event.target.value })}><option>低频（1日以上）</option><option>中频（1小时至4小时）</option><option>高频（5分钟至15分钟）</option></select></label>
            <label>主要市场状态<select value={preferences.marketCondition} onChange={(event) => setPreferences({ ...preferences, marketCondition: event.target.value })}><option>趋势与震荡都要过滤</option><option>只做趋势行情</option><option>只做震荡行情</option><option>突破后跟随</option></select></label>
          </section>
          <label>策略名称<input value={studio.name} onChange={(event) => setStudio({ ...studio, name: event.target.value })} placeholder="输入策略名称" /></label>
          <div className="parameter-pair">
            <label>交易对<select value={studio.symbol} onChange={(event) => setStudio({ ...studio, symbol: event.target.value })}>{["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "DOGE/USDT"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>信号周期<select value={studio.period} onChange={(event) => setStudio({ ...studio, period: event.target.value })}>{["5m", "15m", "1h", "4h", "1D"].map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="parameter-pair">
            <label>交易风格<select value={studio.style} onChange={(event) => setStudio({ ...studio, style: event.target.value })}><option>趋势跟随</option><option>区间交易</option><option>突破动量</option><option>市场中性</option></select></label>
            <label>风险等级<select value={studio.risk} onChange={(event) => setStudio({ ...studio, risk: event.target.value as Studio["risk"] })}><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option></select></label>
          </div>
          {[
            ["单次资金上限", "capital", "%", "30"],
            ["止损比例", "stopLoss", "%", "20"],
            ["止盈目标", "takeProfit", "%", "30"],
            ["最大回撤限制", "maxDrawdown", "%", "30"],
          ].map(([label, key, suffix, max]) => <label className="range-setting" key={key}><span>{label}<b>{studio[key as keyof Studio]}{suffix}</b></span><input type="range" min="1" max={max} step="0.5" value={studio[key as keyof Studio]} onChange={(event) => setStudio({ ...studio, [key]: event.target.value })} /></label>)}
          <label className="studio-rule-field">入场规则<textarea value={studio.entryRule} onChange={(event) => setStudio({ ...studio, entryRule: event.target.value })} placeholder="例：EMA20 上穿 EMA60 且 ADX14 ≥ 22，收盘确认后入场" /></label>
          <label className="studio-rule-field">退出规则<textarea value={studio.exitRule} onChange={(event) => setStudio({ ...studio, exitRule: event.target.value })} placeholder="例：跌破 EMA60 或触发 2×ATR 移动止损" /></label>
          <label className="studio-rule-field">风控与暂停条件<textarea value={studio.riskRule} onChange={(event) => setStudio({ ...studio, riskRule: event.target.value })} placeholder="例：连续3次亏损暂停，单日亏损2%停止开仓" /></label>
          <section className="studio-factor-library">
            <div className="studio-card-heading"><b>成熟因子模板</b><small>点击载入，可继续修改</small></div>
            <div className="studio-factor-grid">{factorPresets.map((preset) => <button type="button" className="studio-factor-card" key={preset.id} onClick={() => applyPreset(preset)}><strong>{preset.title}</strong><span>{preset.summary}</span><small>{preset.tags.join(" · ")}</small></button>)}</div>
          </section>
          <section className="studio-quality-card">
            <div className="studio-card-heading"><b>回测前检查</b><small>{qualityChecks.filter((item) => item.ok).length}/{qualityChecks.length} 已完成</small></div>
            <div className="studio-quality-list">{qualityChecks.map((item) => <span className={item.ok ? "ok" : "todo"} key={item.label}>{item.ok ? "✓" : "!"} {item.label}</span>)}</div>
            {qualityWarnings.map((warning) => <p className="studio-warning" key={warning}>提示：{warning}</p>)}
          </section>
          <label className="studio-indicator-input">当前引擎指标<input value={studio.indicators} onChange={(event) => setStudio({ ...studio, indicators: event.target.value })} placeholder="EMA20, EMA60, RSI14, ATR14" /><small>用逗号分隔。优先选择趋势、波动率、成交量三类因子。</small></label>
        </aside>
      </div>
      <section className="strategy-output">
        <div><small>STRUCTURED STRATEGY</small><h3>{generated ? studio.name || "未命名候选策略" : "等待生成策略"}</h3><p>{generated ? `${studio.symbol} · ${studio.period} · ${studio.style} · 资金≤${studio.capital}% · 止损${studio.stopLoss}% · 止盈${studio.takeProfit}%` : "完成对话和参数设置后生成结构化候选规则。"}</p></div>
        {backtest && <div className="backtest-result"><span>真实回测收益<b>{backtest.netReturnPct == null ? "—" : `${backtest.netReturnPct > 0 ? "+" : ""}${backtest.netReturnPct.toFixed(2)}%`}</b></span><span>最大回撤<b>{backtest.maxDrawdownPct == null ? "—" : `${backtest.maxDrawdownPct.toFixed(2)}%`}</b></span><span>胜率<b>{backtest.winRatePct == null ? "—" : `${backtest.winRatePct.toFixed(1)}%`}</b></span><span>样本数<b>{backtest.sampleSize ?? 0} 笔</b></span></div>}
        {backtest && <p className="strategy-data-note">来源：{backtest.provider || "平台行情引擎"}；手续费 {backtest.feesUsdt?.toFixed(2) || "0.00"} USDT；滑点 {backtest.slippageUsdt?.toFixed(2) || "0.00"} USDT；证据哈希已留存。</p>}
        <div className="studio-actions"><button onClick={generate}>生成候选规则</button><button disabled={!generated || Boolean(busy)} onClick={() => void runDraftBacktest()}>{busy.startsWith("backtest") ? "回测中…" : "真实历史回测"}</button><button className="primary" disabled={!generated || Boolean(busy)} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存到我的策略"}</button></div>
      </section>
    </div>;
  }

  if (view === "mine") {
    return <div className="community-center">
      {message && <div className="notice">{message}</div>}
      <section className="my-strategy-modules">
        <article><i>01</i><div><small>STRATEGY MANAGEMENT</small><h3>策略管理</h3><p>查看草稿、回测报告、审核状态和版本。</p></div><span>{mine.length} 个策略</span></article>
        <article><i>02</i><div><small>BACKTEST CENTER</small><h3>回测与模拟测试</h3><p>历史回测与模拟订单均为可选研究工具，不影响策略提交。</p></div><span>自由测试</span></article>
        <article className="generator"><i>03</i><div><small>AI STRATEGY GENERATOR</small><h3>AI策略生成</h3><p>与策略研究 Agent 沟通，形成可测试、可审核的规则。</p></div><button className="primary" onClick={resetStudio}>创建策略 →</button></article>
      </section>
      <div className="my-strategy-card-grid">{mine.map((row) => {
        const hasBacktest = Boolean(backtestFor(row));
        const id = String(row.id);
        const submitted = ["submitted", "approved", "published"].includes(String(row.status));
        return <article key={id}>
          <header><span>{String(row.status) === "published" ? "已上架" : String(row.status) === "submitted" ? "审核中" : "我的策略"}</span><em>V{String(row.version)}</em></header>
          <h3>{String(row.name)}</h3><p>{((row.symbols || []) as string[]).join(" · ")} · {riskName(row.riskLevel)}</p>
          <div><span className={hasBacktest ? "complete" : ""}>回测报告 {hasBacktest ? "已生成" : "可选"}</span><span>模拟测试 可选</span></div>
          {!submitted && <div className="strategy-backtest-actions"><button disabled={Boolean(busy)} onClick={() => void runBacktest(id)}>{busy === `backtest:${id}` ? "回测中…" : "运行历史回测"}</button></div>}
          <button className="primary" disabled={submitted || Boolean(busy)} onClick={() => void submit(id)}>{String(row.status) === "published" ? "已上架策略广场" : String(row.status) === "submitted" ? "等待平台人工审核" : "提交到策略广场"}</button>
        </article>;
      })}</div>
      {!mine.length && <div className="notice">当前账号还没有真实保存的策略。点击“创建策略”开始，不会再展示虚构草稿。</div>}
    </div>;
  }

  const ordered = [...rows].sort((a, b) => Number(b.rankingScore || 0) - Number(a.rankingScore || 0));
  return <div className="community-center">
    <section>
      <div className="market-section-title"><div><small>COMMUNITY STRATEGIES</small><h2>社区策略综合排名</h2></div><span>收益 · 回撤 · 稳定性 · 有效跟随</span></div>
      <div className="community-grid five-columns">{ordered.map((row, index) => {
        const report = backtestFor(row);
        const hasReport = Boolean(report);
        return <article key={String(row.id)}>
          <header><span>{riskName(row.riskLevel)}</span><em>综合 #{index + 1}</em></header><h3>{String(row.name)}</h3><p>{String(row.summary)}</p>
          <div className="strategy-symbols">{((row.symbols || []) as string[]).map((symbol) => <i key={symbol}>{symbol}</i>)}</div>
          <dl className="strategy-real-metrics">
            <div><dt>历史收益</dt><dd className={Number(report?.netReturnPct || 0) >= 0 ? "green" : "down"}>{hasReport ? `${Number(report?.netReturnPct || 0) > 0 ? "+" : ""}${Number(report?.netReturnPct).toFixed(1)}%` : "暂无报告"}</dd></div>
            <div><dt>最大回撤</dt><dd>{hasReport ? `${Number(report?.maxDrawdownPct || 0).toFixed(1)}%` : "—"}</dd></div>
            <div><dt>历史胜率</dt><dd>{hasReport ? `${Number(report?.winRatePct || 0).toFixed(1)}%` : "—"}</dd></div>
            <div><dt>交易样本</dt><dd>{hasReport ? `${String(report?.sampleSize || 0)} 笔` : "未运行"}</dd></div>
            <div><dt>策略版本</dt><dd>V{String(row.version || 1)}</dd></div><div><dt>有效跟随</dt><dd>{String(row.activeFollowers || 0)} 人</dd></div>
          </dl>
          <div className="strategy-score"><span className="score-main"><small>综合评分</small><b>{String(row.rankingScore || "待评估")}</b></span><div><span>V{String(row.version || 1)}</span><span>{row.demo ? "版面样例" : "回测报告"}</span></div></div>
          <button className="primary strategy-follow-cta" aria-label={`跟随${String(row.name)}`} onClick={() => onOpenStrategy?.(toStrategyDetail(row))}>跟随</button>
        </article>;
      })}</div>
    </section>
    {rows.some((row) => row.demo) && <div className="marketplace-disclosure">数据库尚无已上架策略时显示版面样例；样例不代表真实收益且不可跟随。真实策略由平台人工审核后上架，历史回测与模拟测试均为可选研究工具。</div>}
  </div>;
}
