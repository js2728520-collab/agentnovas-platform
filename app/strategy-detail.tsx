"use client";

import { useMemo, useState } from "react";

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
  source?: "platform" | "community";
  netReturnPct?: number;
  maxDrawdownPct?: number;
  winRatePct?: number;
  sampleSize?: number;
  todayReturnPct?: number;
  yesterdayReturnPct?: number;
  projectedAnnualPct?: number;
};

const riskNames = { low: "低风险", medium: "中风险", high: "高风险" };
const curves: Record<string, number[]> = {
  "30D": [18, 22, 21, 29, 27, 36, 41, 39, 47, 44, 55, 61, 59, 67, 71, 78],
  "90D": [12, 18, 17, 24, 31, 28, 36, 43, 47, 45, 53, 60, 57, 69, 73, 82],
  "全部": [8, 14, 21, 18, 26, 32, 30, 38, 46, 42, 55, 62, 59, 71, 76, 86],
};

function value(value: number | undefined, suffix = "%") {
  return value == null ? "样本不足" : `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

export default function StrategyDetail({ strategy, onBack }: { strategy: StrategyDetailData; onBack: () => void }) {
  const [period, setPeriod] = useState("30D");
  const [capital, setCapital] = useState(20);
  const [stopLoss, setStopLoss] = useState(8);
  const [account, setAccount] = useState("OKX 模拟账户");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const curve = curves[period];
  const isDemo = strategy.id.startsWith("demo-") || strategy.id.startsWith("ai-");
  const metrics = useMemo(() => [
    ["累计收益", value(strategy.netReturnPct)],
    ["最大回撤", strategy.maxDrawdownPct == null ? "样本不足" : `${strategy.maxDrawdownPct.toFixed(2)}%`],
    ["历史胜率", strategy.winRatePct == null ? "样本不足" : `${strategy.winRatePct.toFixed(1)}%`],
    ["交易样本", strategy.sampleSize == null ? "样本不足" : `${strategy.sampleSize} 笔`],
    ["有效跟随", `${strategy.activeFollowers} 人`],
    ["综合评分", strategy.rankingScore ? strategy.rankingScore.toFixed(1) : "待评估"],
  ], [strategy]);

  function requestFollow() {
    if (!agreed) {
      setMessage("请先阅读并确认策略风险说明");
      return;
    }
    setMessage("");
    setConfirming(true);
  }

  async function follow() {
    setBusy(true);
    setMessage("");
    try {
      if (isDemo) {
        await new Promise(resolve => setTimeout(resolve, 450));
        setMessage("跟随设置已保存。演示策略将在账户检查与风控确认后进入模拟运行。");
      } else {
        const response = await fetch(`/api/strategy-marketplace/${strategy.id}/follow`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ account, capitalPct: capital, stopLossPct: stopLoss }),
        });
        const raw = await response.text();
        const result = raw ? JSON.parse(raw) as { error?: string; message?: string } : {};
        setMessage(result.message || result.error || (response.ok ? "跟随申请已提交" : "暂时无法提交跟随申请"));
      }
    } catch {
      setMessage("当前服务暂未连接，请稍后重试");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return <div className="strategy-detail-page">
    <button className="strategy-detail-back" onClick={onBack}>← 返回策略广场</button>
    <section className={`strategy-detail-hero ${strategy.source === "platform" ? "platform" : "community"}`}>
      <div className="strategy-detail-copy">
        <div className="strategy-detail-kicker"><i />{strategy.source === "platform" ? "AGENTNOVAS AI CORE" : "VERIFIED COMMUNITY STRATEGY"}</div>
        <div className="strategy-detail-title"><div className="strategy-detail-mark">{strategy.source === "platform" ? "AI" : strategy.name.slice(0, 1)}</div><div><span>{riskNames[strategy.riskLevel]} · V{strategy.version}</span><h1>{strategy.name}</h1><p>{strategy.summary}</p></div></div>
        <div className="strategy-detail-tags">{strategy.symbols.map(symbol => <span key={symbol}>{symbol}</span>)}<span>多 Agent 审核</span><span>硬风控约束</span></div>
      </div>
      <div className="strategy-detail-status"><span><i />运行状态</span><b>策略监控正常</b><small>{isDemo ? "当前为界面演示数据" : "数据来自策略记录与成交归因"}</small></div>
    </section>

    <div className="strategy-detail-layout">
      <main>
        <section className="strategy-detail-metrics">{metrics.map((item, index) => <article key={item[0]}><small>{item[0]}</small><b className={index === 0 ? "up" : ""}>{item[1]}</b>{index < 4 && <span>{isDemo ? "演示记录" : "已记录数据"}</span>}</article>)}</section>

        <section className="strategy-performance-panel">
          <header><div><small>PERFORMANCE</small><h2>策略表现</h2></div><nav>{Object.keys(curves).map(x => <button className={period === x ? "active" : ""} key={x} onClick={() => setPeriod(x)}>{x}</button>)}</nav></header>
          <div className="strategy-performance-chart"><div className="chart-grid"><span>+30%</span><span>+20%</span><span>+10%</span><span>0%</span></div><div className="chart-bars">{curve.map((height, index) => <i key={index} style={{ height: `${height}%` }}><b /></i>)}</div><div className="chart-caption"><span>{period === "30D" ? "30天前" : period === "90D" ? "90天前" : "开始运行"}</span><strong>{value(strategy.netReturnPct)}</strong><span>现在</span></div></div>
          <p className="strategy-data-note">{isDemo ? "当前数据用于展示页面结构，不代表真实收益或未来表现。正式运行后将按已归因成交、手续费和资金费率计算。" : "收益仅统计带平台决策编号的已实现净收益；客户手动订单不计入策略表现。"}</p>
        </section>

        <section className="strategy-information-grid">
          <article><small>STRATEGY LOGIC</small><h3>策略逻辑</h3><p>结合多周期趋势、波动率与成交量确认识别交易机会。信号必须同时满足数据完整性、风险预算和执行条件才会提交。</p><ul><li>趋势与市场状态识别</li><li>成交量和流动性过滤</li><li>分批入场与动态退出</li><li>异常行情自动停止开仓</li></ul></article>
          <article><small>RISK BOUNDARIES</small><h3>风险边界</h3><p>AI可以调整仓位和退出节奏，但不能突破账户级硬风控。任何 Agent 均无权绕过风险审批。</p><dl><div><dt>单次资金上限</dt><dd>≤ 8%</dd></div><div><dt>策略最大杠杆</dt><dd>2×</dd></div><div><dt>连续失败熔断</dt><dd>3 次</dd></div><div><dt>行情延迟阈值</dt><dd>3 秒</dd></div></dl></article>
        </section>

        <section className="strategy-agent-chain"><header><div><small>DECISION CHAIN</small><h2>Agent 决策与审核链</h2></div><span>每次交易生成唯一决策编号</span></header><div>{[["市场分析","识别行情状态与流动性"],["技术分析","验证多周期信号"],["策略研究","生成候选交易方案"],["反方审查","寻找反向证据与漏洞"],["风险审批","校验账户硬边界"],["交易执行","授权后提交交易所"],["审计归档","记录订单与成交归因"]].map((x, i) => <article key={x[0]}><i>{i + 1}</i><b>{x[0]}</b><span>{x[1]}</span></article>)}</div></section>
      </main>

      <aside className="strategy-follow-panel">
        <div className="follow-panel-head"><small>FOLLOW STRATEGY</small><h2>跟随此策略</h2><p>提交后先进行会员、账户连接与风险检查，通过后才会开始运行。</p></div>
        <label>跟随账户<select value={account} onChange={e => setAccount(e.target.value)}><option>OKX 模拟账户</option><option>选择其他已连接账户</option></select></label>
        <label className="follow-range"><span>资金使用上限 <b>{capital}%</b></span><input type="range" min="5" max="50" step="5" value={capital} onChange={e => setCapital(Number(e.target.value))} /></label>
        <label className="follow-range"><span>策略止损线 <b>{stopLoss}%</b></span><input type="range" min="3" max="20" value={stopLoss} onChange={e => setStopLoss(Number(e.target.value))} /></label>
        <div className="follow-summary"><span>跟随方式<b>按比例同步</b></span><span>方向限制<b>策略信号订单</b></span><span>风控模式<b>账户边界优先</b></span></div>
        <label className="follow-agreement"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} /><span>我已了解策略可能产生亏损，历史表现不代表未来收益，并同意先完成账户风险检查。</span></label>
        {confirming && <div className="strategy-follow-confirmation">
          <header><span>确认跟随参数</span><button onClick={() => setConfirming(false)}>×</button></header>
          <dl><div><dt>策略</dt><dd>{strategy.name}</dd></div><div><dt>账户</dt><dd>{account}</dd></div><div><dt>资金上限</dt><dd>{capital}%</dd></div><div><dt>止损线</dt><dd>{stopLoss}%</dd></div></dl>
          <p>提交后仍需通过会员、API 权限和账户硬风控检查，通过前不会自动开仓。</p>
          <div><button onClick={() => setConfirming(false)}>返回修改</button><button className="primary" disabled={busy} onClick={() => void follow()}>{busy ? "正在提交…" : "确认并提交"}</button></div>
        </div>}
        <button className="strategy-follow-button" disabled={busy || confirming} onClick={requestFollow}>{busy ? "正在提交…" : "申请跟随策略 →"}</button>
        {message && <div className="strategy-follow-message">{message}</div>}
        <footer><span>可随时暂停新开仓</span><span>已有仓位继续受风控管理</span></footer>
      </aside>
    </div>
  </div>;
}
