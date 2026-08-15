"use client";

import { useEffect, useMemo, useState } from "react";
import { strategyRequiresContracts } from "@/lib/exchange-capabilities";

export type StrategyDetailData = {
  id: string;
  name: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  symbols: string[];
  version: number;
  rankingScore: number;
  activeFollowers: number;
  publishedAt?: string;
  authorEmail?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  authorRole?: string;
  source?: "platform" | "community";
  netReturnPct?: number;
  maxDrawdownPct?: number;
  winRatePct?: number;
  sampleSize?: number;
  todayReturnPct?: number;
  yesterdayReturnPct?: number;
  projectedMonthlyPct?: number;
  market?: string;
};

type ExchangeAccount = {
  id: string;
  exchange: string;
  label: string;
  environment: "demo" | "live";
  status: string;
  canRead: boolean;
  canTrade: boolean;
  capabilities?: {
    displayName: string;
    supportsSpot: boolean;
    supportsContracts: boolean;
    contractNote?: string;
  } | null;
};

const riskNames = { low: "低风险", medium: "中风险", high: "高风险" };
const authorRoleNames: Record<string, string> = {
  customer: "社区策略作者",
  employee: "策略研究员",
  manager: "策略负责人",
  hq_admin: "平台管理员",
};
const curves: Record<string, number[]> = {
  "30D": [18, 22, 21, 29, 27, 36, 41, 39, 47, 44, 55, 61, 59, 67, 71, 78],
  "90D": [12, 18, 17, 24, 31, 28, 36, 43, 47, 45, 53, 60, 57, 69, 73, 82],
  "全部": [8, 14, 21, 18, 26, 32, 30, 38, 46, 42, 55, 62, 59, 71, 76, 86],
};

function percent(value: number | undefined) {
  return value == null ? "样本不足" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function safeJson<T>(raw: string): T | null {
  try { return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

export default function StrategyDetail({ strategy, onBack }: { strategy: StrategyDetailData; onBack: () => void }) {
  const [period, setPeriod] = useState("30D");
  const [capital, setCapital] = useState(20);
  const [stopLoss, setStopLoss] = useState(8);
  const [accounts, setAccounts] = useState<ExchangeAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const isPresentation = strategy.id.startsWith("demo-") || strategy.id.startsWith("ai-");
  const selectedAccount = accounts.find((item) => item.id === accountId);
  const requiresContracts = strategyRequiresContracts(strategy as unknown as Record<string, unknown>);
  const accountMarketWarning = selectedAccount && requiresContracts && !selectedAccount.capabilities?.supportsContracts
    ? `${selectedAccount.exchange} 当前连接按现货处理，不能跟随需要合约的策略，请更换支持合约的交易所。`
    : "";
  const curve = curves[period];
  const authorName = strategy.authorName || strategy.authorEmail?.split("@")[0] || (strategy.source === "platform" ? "AgentNovas AI Core" : "社区策略作者");
  const authorRole = authorRoleNames[strategy.authorRole || ""] || strategy.authorRole || (strategy.source === "platform" ? "平台 AI 策略团队" : "社区策略作者");

  useEffect(() => {
    setAccounts([]);
    setAccountId("");
    setAccountsLoading(false);
  }, []);

  const metrics = useMemo(() => [
    ["累计收益", percent(strategy.netReturnPct)],
    ["最大回撤", strategy.maxDrawdownPct == null ? "样本不足" : `${strategy.maxDrawdownPct.toFixed(2)}%`],
    ["历史胜率", strategy.winRatePct == null ? "样本不足" : `${strategy.winRatePct.toFixed(1)}%`],
    ["交易样本", strategy.sampleSize == null ? "样本不足" : `${strategy.sampleSize} 笔`],
    ["有效跟随", `${strategy.activeFollowers} 人`],
    ["综合评分", strategy.rankingScore ? strategy.rankingScore.toFixed(1) : "待评估"],
  ], [strategy]);

  function requestFollow() {
    setMessage("实盘跟单尚未开放；你可以先在“我的策略”中对自己创建的策略进行历史回测和模拟测试。");
    return;
    /* istanbul ignore next */
    if (isPresentation) {
      setMessage("该平台 AI 方案目前为明确标注的界面演示，尚未接入真实策略版本与执行引擎，暂不能跟随。");
      return;
    }
    if (!accountId) {
      setMessage("请先在交易中心连接并通过检测的模拟交易账户。");
      return;
    }
    if (!agreed) {
      setMessage("请先阅读并确认策略风险说明。");
      return;
    }
    setMessage("");
    setConfirming(true);
  }

  async function follow() {
    if (!accountId || isPresentation) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/strategy-marketplace/${strategy.id}/follow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          exchangeAccountId: accountId,
          capitalPct: capital,
          stopLossPct: stopLoss,
          executionMode: "proportional",
          riskConsent: true,
        }),
      });
      const result = safeJson<{ error?: string; message?: string }>(await response.text());
      setMessage(result?.message || result?.error || (response.ok ? "模拟跟随已激活" : "暂时无法提交跟随申请"));
    } catch {
      setMessage("当前服务暂未连接，请稍后重试。");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return <div className="strategy-detail-page">
    <button className="strategy-detail-back" onClick={onBack}>← 返回策略广场</button>
    <section className={`strategy-detail-hero ${strategy.source === "platform" ? "platform" : "community"}`}>
      <div className="strategy-detail-copy">
        <div className="strategy-detail-kicker"><i />{strategy.source === "platform" ? "AGENTNOVAS AI CORE" : "COMMUNITY STRATEGY"}</div>
        <div className="strategy-detail-title"><div className="strategy-detail-mark">{strategy.source === "platform" ? "AI" : strategy.name.slice(0, 1)}</div><div><span>{riskNames[strategy.riskLevel]} · V{strategy.version}</span><h1>{strategy.name}</h1><p>{strategy.summary}</p></div></div>
        <div className="strategy-detail-tags">{strategy.symbols.map((symbol) => <span key={symbol}>{symbol}</span>)}<span>多 Agent 审核</span><span>硬风控约束</span></div>
      </div>
      <div className="strategy-detail-status"><span><i />数据状态</span><b>{isPresentation ? "演示方案 · 不可跟随" : "策略数据已记录"}</b><small>{isPresentation ? "不代表真实收益或未来表现" : "指标来自当前策略版本的回测或实盘记录"}</small></div>
    </section>

    <div className="strategy-detail-layout">
      <main>
        <section className="strategy-detail-metrics">{metrics.map((item, index) => <article key={item[0]}><small>{item[0]}</small><b className={index === 0 ? "up" : ""}>{item[1]}</b>{index < 4 && <span>{isPresentation ? "演示数据" : "版本记录"}</span>}</article>)}</section>
        <section className="strategy-performance-panel">
          <header><div><small>PERFORMANCE</small><h2>策略表现</h2></div><nav>{Object.keys(curves).map((item) => <button className={period === item ? "active" : ""} key={item} onClick={() => setPeriod(item)}>{item}</button>)}</nav></header>
          <div className="strategy-performance-chart"><div className="chart-grid"><span>+30%</span><span>+20%</span><span>+10%</span><span>0%</span></div><div className="chart-bars">{curve.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div><div className="chart-caption"><span>{period === "30D" ? "30天前" : period === "90D" ? "90天前" : "开始运行"}</span><strong>{percent(strategy.netReturnPct)}</strong><span>现在</span></div></div>
          <p className="strategy-data-note">页面柱形曲线仅用于版面趋势示意，不作为策略实绩证据。{isPresentation ? "当前方案尚未产生可核验成交记录。" : "正式指标以回测报告、决策编号和已归因成交为准；客户手动订单不计入。"}</p>
        </section>
        <section className="strategy-information-grid">
          <article><small>STRATEGY LOGIC</small><h3>策略逻辑</h3><p>结合多周期趋势、波动率与成交量确认识别交易机会。信号必须同时满足数据完整性、风险预算和执行条件才会提交。</p><ul><li>趋势与市场状态识别</li><li>成交量和流动性过滤</li><li>分批入场与动态退出</li><li>异常行情自动停止开仓</li></ul></article>
          <article><small>RISK BOUNDARIES</small><h3>风险边界</h3><p>AI可以提出仓位和退出建议，但不能突破账户级硬风控，也无权绕过风控审批。</p><dl><div><dt>单次资金上限</dt><dd>≤ 8%</dd></div><div><dt>策略最大杠杆</dt><dd>2×</dd></div><div><dt>连续失败熔断</dt><dd>3 次</dd></div><div><dt>行情延迟阈值</dt><dd>3 秒</dd></div></dl></article>
        </section>
        <section className="strategy-author-panel"><div className="strategy-author-heading"><div className="strategy-author-avatar">{strategy.authorAvatarUrl?.startsWith("http") ? <img src={strategy.authorAvatarUrl} alt="" /> : strategy.source === "platform" ? "AI" : authorName.slice(0, 1).toUpperCase()}</div><div><small>AUTHOR PROFILE</small><h2>作者信息</h2></div></div><div className="strategy-author-content"><div><b>{authorName}</b><span>{authorRole}</span></div><dl><div><dt>发布方式</dt><dd>{strategy.source === "platform" ? "平台策略" : "策略广场"}</dd></div><div><dt>策略版本</dt><dd>V{strategy.version}</dd></div>{strategy.authorEmail && <div><dt>联系邮箱</dt><dd>{strategy.authorEmail}</dd></div>}</dl></div></section>
      </main>

      <aside className="strategy-follow-panel">
        <div className="follow-panel-head"><small>FOLLOW STRATEGY</small><h2>跟随此策略</h2><p>实盘跟单尚未开放，平台不会通过模拟账户替客户自动开仓。</p></div>
        <label>跟随账户<select value={accountId} disabled><option value="">实盘跟单暂未开放</option></select></label>
        {accountMarketWarning && <div className="strategy-follow-warning">{accountMarketWarning}</div>}
        <label className="follow-range"><span>资金使用上限 <b>{capital}%</b></span><input type="range" min="5" max="50" step="5" value={capital} onChange={(event) => setCapital(Number(event.target.value))} /></label>
        <label className="follow-range"><span>策略止损线 <b>{stopLoss}%</b></span><input type="range" min="3" max="20" value={stopLoss} onChange={(event) => setStopLoss(Number(event.target.value))} /></label>
        <div className="follow-summary"><span>跟随方式<b>暂未启用</b></span><span>执行环境<b>不自动执行</b></span><span>风控模式<b>账户边界优先</b></span></div>
        <label className="follow-agreement"><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><span>我已了解策略可能产生亏损，历史表现不代表未来收益，并同意先完成账户风险检查。</span></label>
        {confirming && <div className="strategy-follow-confirmation"><header><span>确认跟随参数</span><button onClick={() => setConfirming(false)}>×</button></header><dl><div><dt>策略</dt><dd>{strategy.name}</dd></div><div><dt>账户</dt><dd>{selectedAccount ? `${selectedAccount.exchange} · ${selectedAccount.label}` : "未选择"}</dd></div><div><dt>资金上限</dt><dd>{capital}%</dd></div><div><dt>止损线</dt><dd>{stopLoss}%</dd></div></dl><p>提交后仍需通过会员、API权限和账户硬风控检查，通过前不会自动开仓。</p><div><button onClick={() => setConfirming(false)}>返回修改</button><button className="primary" disabled={busy} onClick={() => void follow()}>{busy ? "正在提交…" : "确认并提交"}</button></div></div>}
        <button className="strategy-follow-button" disabled={true} onClick={requestFollow}>实盘跟单暂未开放</button>
        {message && <div className="strategy-follow-message">{message}</div>}
        <footer><span>可随时暂停新开仓</span><span>已有仓位继续受风控管理</span></footer>
      </aside>
    </div>
  </div>;
}
