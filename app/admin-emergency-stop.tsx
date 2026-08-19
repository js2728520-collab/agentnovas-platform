"use client";

import { useEffect, useState } from "react";

export default function AdminEmergencyStop({ role }: { role: "hq_admin" | "branch_admin" }) {
  const [active, setActive] = useState(false);
  const [scopeLabel, setScopeLabel] = useState(role === "hq_admin" ? "全部分公司客户" : "当前分公司客户");
  const [affectedCustomers, setAffectedCustomers] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = async () => {
    const response = await fetch("/api/admin/trading/emergency-stop", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data.error || "读取紧急停止状态失败"));
    setActive(Boolean(data.active));
    setScopeLabel(String(data.scopeLabel || scopeLabel));
    setAffectedCustomers(Number(data.affectedCustomers || 0));
  };

  useEffect(() => {
    void load().catch(() => undefined);
  }, [role]);

  const submit = async (closePositions: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/trading/emergency-stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: !active, closePositions, reason: closePositions ? "管理员选择强制平仓" : "管理员选择仅暂停新开仓" }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error || "紧急停止操作失败"));
      setActive(Boolean(data.active));
      setAffectedCustomers(Number(data.affectedCustomers || affectedCustomers));
      setMessage(String(data.message || "操作已完成"));
      setOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "紧急停止操作失败");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <button type="button" className={`danger admin-emergency-stop-button${active ? " is-active" : ""}`} title={`作用范围：${scopeLabel}`} onClick={() => { setMessage(""); setOpen(true); }}>{active ? "解除紧急停止" : "全局紧急停止"}</button>
    {message && <span className="admin-emergency-stop-message" role="status">{message}</span>}
    {open && <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) setOpen(false); }}><div className="dialog-card admin-emergency-stop-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-emergency-stop-title"><button type="button" className="dialog-close" disabled={busy} onClick={() => setOpen(false)}>×</button><span className="emergency-dialog-kicker">ADMIN TRADING SAFETY CONTROL</span><h2 id="admin-emergency-stop-title">{active ? "解除紧急停止" : "选择紧急停止方式"}</h2><p>作用范围：<b>{scopeLabel}</b>，当前涉及约 {affectedCustomers} 个客户。</p>{active ? <div className="admin-emergency-stop-actions"><button type="button" className="primary" disabled={busy} onClick={() => void submit(false)}>{busy ? "处理中…" : "解除紧急停止"}</button></div> : <div className="admin-emergency-stop-actions"><button type="button" className="emergency-keep" disabled={busy} onClick={() => void submit(false)}><b>暂停新开仓</b><small>保留客户现有仓位，不执行平仓</small></button><button type="button" className="emergency-close-all" disabled={busy} onClick={() => void submit(true)}><b>暂停并全平</b><small>暂停新开仓，并对可接通仓位发起真实平仓</small></button></div>}<button type="button" className="emergency-cancel" disabled={busy} onClick={() => setOpen(false)}>取消</button></div></div>}
  </>;
}
