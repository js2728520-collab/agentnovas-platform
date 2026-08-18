"use client";

import { useEffect, useState } from "react";

type DepartmentRow = { code: string; label: string; rate: number; amountUsdt: number };
type AgentPeriodRow = { agentId: string; email: string; nickname: string; status: string; performanceUsdt: number; commissionRate: number; commissionUsdt: number };

const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (value: unknown) => numberValue(value).toFixed(2);

export default function MonthlyRevenue() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch(`/api/reports/monthly?month=${month}`);
      setData(await response.json() as Record<string, unknown>);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [month]);

  const root = data || {};
  const summary = (root.summary || {}) as Record<string, unknown>;
  const departments = Array.isArray(root.departmentAllocations) ? root.departmentAllocations as DepartmentRow[] : [];
  const agents = Array.isArray(root.personalAgents) ? root.personalAgents as AgentPeriodRow[] : [];
  const allocations = Array.isArray(root.allocations) ? root.allocations as Array<Record<string, unknown>> : [];
  const totalGross = numberValue(summary.totalRevenue);
  const operatingCost = numberValue(summary.operatingCost);
  const websiteRevenue = numberValue(summary.websiteRevenue);
  const hqShare = numberValue(summary.headquartersWebsiteShare);
  const branchShare = numberValue(summary.branchWebsiteShare);

  return <section className="monthly-report">
    <div className="monthly-report-head"><div><small>HQ REVENUE REPORT</small><h2>总公司月度收益报表</h2><p>按确认到账记录核算。本页将充值/会员收入拆分为 50% 总公司运营成本，剩余 50% 作为网站收益，再按总公司 20%、分公司 80%分配。</p></div><div className="monthly-report-tools"><label>结算月份<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><button className="primary" onClick={() => void load()} disabled={loading}>{loading ? "读取中…" : "刷新报表"}</button></div></div>
    <div className="monthly-report-kpis"><article><small>本月确认收入</small><strong>{money(totalGross)} <em>USDT</em></strong><span>所有已确认收入事件</span></article><article><small>运营成本 50%</small><strong>{money(operatingCost)} <em>USDT</em></strong><span>充值/会员收入中留存总公司</span></article><article><small>网站可分配收益</small><strong>{money(websiteRevenue)} <em>USDT</em></strong><span>部门与组织分配的计算基数</span></article><article><small>个人代理当月分成</small><strong>{money(summary.personalAgentCommissionTotal)} <em>USDT</em></strong><span>按本月业绩阶梯核算</span></article></div>
    <div className="monthly-report-rule-grid"><article><span>总公司网站收益</span><b>20% · {money(hqShare)} USDT</b></article><article><span>分公司收益</span><b>80% · {money(branchShare)} USDT</b></article><article><span>部门合计</span><b>{departments.reduce((sum, row) => sum + numberValue(row.rate), 0) * 100}%</b></article></div>
    <div className="monthly-report-grid"><article className="monthly-chart-card report-table-card"><div className="monthly-chart-title"><div><small>HQ DEPARTMENTS</small><h3>总公司实体部门分配</h3></div><span>基于网站可分配收益</span></div><div className="table-wrap admin-data"><table><thead><tr><th>部门</th><th>分配比例</th><th>本月金额 USDT</th></tr></thead><tbody>{departments.length ? departments.map((row) => <tr key={row.code}><td>{row.label}</td><td>{(numberValue(row.rate) * 100).toFixed(1)}%</td><td>{money(row.amountUsdt)}</td></tr>) : <tr><td colSpan={3}>暂无可分配收益</td></tr>}</tbody></table></div></article><article className="monthly-chart-card report-table-card"><div className="monthly-chart-title"><div><small>PERSONAL AGENT TIERS</small><h3>个人代理月度阶梯</h3></div><span>每月清零</span></div><div className="personal-agent-report-list"><div><span>低于 1,000 USDT</span><b>20%</b></div><div><span>1,000–4,999.99 USDT</span><b>25%</b></div><div><span>5,000–9,999.99 USDT</span><b>30%</b></div><div><span>10,000–19,999.99 USDT</span><b>35%</b></div><div><span>20,000–49,999.99 USDT</span><b>40%</b></div><div><span>50,000 USDT 及以上</span><b>50%</b></div></div></article></div>
    <section className="monthly-agent-ledger"><div className="monthly-chart-title"><div><small>AGENT LEDGER</small><h3>{month} 个人代理业绩台账</h3></div><span>不结转上月</span></div>{agents.length ? <div className="table-wrap admin-data"><table><thead><tr><th>代理</th><th>状态</th><th>本月业绩 USDT</th><th>比例</th><th>应分成 USDT</th></tr></thead><tbody>{agents.map((row) => <tr key={row.agentId}><td>{row.nickname || row.email}<small>{row.email}</small></td><td>{row.status === "active" ? "正常" : row.status}</td><td>{money(row.performanceUsdt)}</td><td>{(numberValue(row.commissionRate) * 100).toFixed(0)}%</td><td>{money(row.commissionUsdt)}</td></tr>)}</tbody></table></div> : <div className="monthly-chart-empty"><strong>本月暂无个人代理业绩</strong><span>创建个人代理并在代理台账中录入本月业绩后，这里会自动计算分成。</span></div>}</section>
    <details className="monthly-report-details"><summary>查看实际收入分配账本</summary><pre>{JSON.stringify({ month, allocations }, null, 2)}</pre></details>
  </section>;
}
