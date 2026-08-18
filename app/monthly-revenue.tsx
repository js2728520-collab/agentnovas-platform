"use client";

import { useCallback, useEffect, useState } from "react";

type AgentPeriodRow = { agentId: string; email: string; nickname: string; status: string; performanceUsdt: number; commissionRate: number; commissionUsdt: number };

const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (value: unknown) => numberValue(value).toFixed(2);

export default function MonthlyRevenue() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/reports/monthly?month=${month}`);
      setData(await response.json() as Record<string, unknown>);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const root = data || {};
  const summary = (root.summary || {}) as Record<string, unknown>;
  const agents = Array.isArray(root.personalAgents) ? root.personalAgents as AgentPeriodRow[] : [];
  const allocations = Array.isArray(root.allocations) ? root.allocations as Array<Record<string, unknown>> : [];
  const totalGross = numberValue(summary.totalRevenue);
  const branchShare = numberValue(summary.branchWebsiteShare);
  const isPersonalAgent = root.scope === "personal_agent";

  return <section className="monthly-report">
    <div className="monthly-report-head"><div><small>SCOPED MONTHLY DIVIDEND</small><h2>{isPersonalAgent ? "个人代理月度分红" : "分公司月度分红"}</h2><p>本页只展示当前账号有权查看的确认分配，不披露总公司、其他分公司或其他代理的收入数据。</p></div><div className="monthly-report-tools"><label>结算月份<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><button className="primary" onClick={() => void load()} disabled={loading}>{loading ? "读取中…" : "刷新报表"}</button></div></div>
    <div className="monthly-report-kpis"><article><small>当前账号可见分配</small><strong>{money(totalGross)} <em>USDT</em></strong><span>仅统计分配给本账号或所属分公司的已确认记录</span></article><article><small>会员相关分配</small><strong>{money(summary.membershipRevenue)} <em>USDT</em></strong><span>当前权限范围内的会员收入分配</span></article><article><small>{isPersonalAgent ? "本月代理业绩" : "分公司分红"}</small><strong>{money(isPersonalAgent ? agents.reduce((sum, row) => sum + numberValue(row.performanceUsdt), 0) : branchShare)} <em>USDT</em></strong><span>{isPersonalAgent ? "每月重新累计" : "当前分公司确认到账金额"}</span></article><article><small>个人代理当月分成</small><strong>{money(summary.personalAgentCommissionTotal)} <em>USDT</em></strong><span>个人代理按本月业绩阶梯核算</span></article></div>
    <div className="monthly-report-rule-grid"><article><span>数据可见范围</span><b>{isPersonalAgent ? "仅本人" : "仅本分公司"}</b></article><article><span>本月可见金额</span><b>{money(totalGross)} USDT</b></article><article><span>跨组织数据</span><b>不可见</b></article></div>
    <div className="monthly-report-grid"><article className="monthly-chart-card report-table-card"><div className="monthly-chart-title"><div><small>VISIBLE ALLOCATIONS</small><h3>当前账号分配明细</h3></div><span>权限范围内</span></div><div className="table-wrap admin-data"><table><thead><tr><th>分配类型</th><th>归属编号</th><th>本月金额 USDT</th></tr></thead><tbody>{allocations.length ? allocations.map((row, index) => <tr key={`${String(row.beneficiaryType)}-${index}`}><td>{String(row.beneficiaryType || "-")}</td><td>{String(row.beneficiaryId || "当前账号")}</td><td>{money(row.amount)}</td></tr>) : <tr><td colSpan={3}>本月暂无可见分配</td></tr>}</tbody></table></div></article><article className="monthly-chart-card report-table-card"><div className="monthly-chart-title"><div><small>PERSONAL AGENT TIERS</small><h3>个人代理月度阶梯</h3></div><span>每月清零</span></div><div className="personal-agent-report-list"><div><span>低于 1,000 USDT</span><b>20%</b></div><div><span>1,000–4,999.99 USDT</span><b>25%</b></div><div><span>5,000–9,999.99 USDT</span><b>30%</b></div><div><span>10,000–19,999.99 USDT</span><b>35%</b></div><div><span>20,000–49,999.99 USDT</span><b>40%</b></div><div><span>50,000 USDT 及以上</span><b>50%</b></div></div></article></div>
    <section className="monthly-agent-ledger"><div className="monthly-chart-title"><div><small>AGENT LEDGER</small><h3>{month} 个人代理业绩台账</h3></div><span>不结转上月</span></div>{agents.length ? <div className="table-wrap admin-data"><table><thead><tr><th>代理</th><th>状态</th><th>本月业绩 USDT</th><th>比例</th><th>应分成 USDT</th></tr></thead><tbody>{agents.map((row) => <tr key={row.agentId}><td>{row.nickname || row.email}<small>{row.email}</small></td><td>{row.status === "active" ? "正常" : row.status}</td><td>{money(row.performanceUsdt)}</td><td>{(numberValue(row.commissionRate) * 100).toFixed(0)}%</td><td>{money(row.commissionUsdt)}</td></tr>)}</tbody></table></div> : <div className="monthly-chart-empty"><strong>本月暂无个人代理业绩</strong><span>创建个人代理并在代理台账中录入本月业绩后，这里会自动计算分成。</span></div>}</section>
    <details className="monthly-report-details"><summary>查看实际收入分配账本</summary><pre>{JSON.stringify({ month, allocations }, null, 2)}</pre></details>
  </section>;
}
