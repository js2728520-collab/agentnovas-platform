"use client";

import { useEffect, useState } from "react";

type AgentRow = {
  id: string;
  email: string;
  nickname: string;
  status: string;
  userStatus: string;
  performanceUsdt: number;
  commissionRate: number;
  commissionUsdt: number;
};

export default function PersonalAgentAdmin({ onDone }: { onDone: (message: string) => void }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch(`/api/organization/personal-agents?month=${month}`);
    if (!response.ok) return;
    const data = await response.json() as { agents?: AgentRow[] };
    const nextRows = data.agents || [];
    setRows(nextRows);
    setDrafts(Object.fromEntries(nextRows.map((row) => [row.id, String(row.performanceUsdt || 0)])));
  }

  useEffect(() => { void load(); }, [month]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/organization/personal-agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const data = await response.json() as { message?: string; error?: string };
      const nextMessage = data.message || data.error || "操作完成";
      setMessage(nextMessage);
      onDone(nextMessage);
      if (response.ok) { event.currentTarget.reset(); await load(); }
    } finally {
      setBusy(false);
    }
  }

  async function savePerformance(agentId: string) {
    const performanceUsdt = Number(drafts[agentId] || 0);
    if (!Number.isFinite(performanceUsdt) || performanceUsdt < 0) { setMessage("业绩必须是大于等于 0 的数字"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/organization/personal-agents", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, month, performanceUsdt }) });
      const data = await response.json() as { message?: string; error?: string };
      const nextMessage = data.message || data.error || "操作完成";
      setMessage(nextMessage);
      onDone(nextMessage);
      if (response.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  return <section className="wide-panel personal-agent-panel">
    <div className="personal-agent-head"><div><small>PERSONAL AGENT COMMISSION</small><h2>个人代理</h2><p>总公司创建个人代理账户，并按每月实际业绩计算当月分成。进入新月份自动从 0 开始，不结转上月业绩。</p></div><label>核算月份<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></div>
    <form className="admin-inline-form personal-agent-create" onSubmit={(event) => void create(event)}>
      <label>代理名称<input name="name" required placeholder="例如：Alex Carter" /></label>
      <label>登录邮箱<input name="email" type="email" required placeholder="agent@example.com" /></label>
      <button className="primary" disabled={busy}>创建个人代理</button>
    </form>
    {message && <div className="admin-notice">{message}</div>}
    {rows.length ? <div className="table-wrap admin-data personal-agent-table"><table><thead><tr><th>代理</th><th>账户状态</th><th>本月业绩 USDT</th><th>分成比例</th><th>本月分成 USDT</th><th>操作</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><b>{row.nickname || row.email}</b><small>{row.email}</small></td><td>{row.userStatus === "pending" ? "待激活" : row.status === "active" ? "正常" : row.status}</td><td><input className="personal-agent-performance" type="number" min="0" step="0.01" value={drafts[row.id] ?? "0"} onChange={(event) => setDrafts((previous) => ({ ...previous, [row.id]: event.target.value }))} /></td><td>{(row.commissionRate * 100).toFixed(0)}%</td><td>{Number(row.commissionUsdt || 0).toFixed(2)}</td><td><button className="primary" disabled={busy} onClick={() => void savePerformance(row.id)}>保存本月业绩</button></td></tr>)}</tbody></table></div> : <div className="admin-empty">本月暂无个人代理。创建后，本月台账会从 0 开始。</div>}
    <div className="personal-agent-tier-note"><b>阶梯规则</b><span>低于 1,000：20%</span><span>1,000–4,999.99：25%</span><span>5,000–9,999.99：30%</span><span>10,000–19,999.99：35%</span><span>20,000–49,999.99：40%</span><span>50,000 及以上：50%</span></div>
  </section>;
}
