"use client";

import { useEffect, useMemo, useState } from "react";

type Account = { id: string; exchange: string; label: string; environment: string; status: string; canTrade: boolean };
type Strategy = { id: string; name: string; status: string; version: number; symbols?: string[] };

function safeJson<T>(raw: string): T | null {
  try { return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

export default function SimulatedOrderForm({ accounts, allowed, onDone }: { accounts: Account[]; allowed: boolean; onDone: () => void }) {
  const eligible = useMemo(() => accounts.filter((item) => item.environment === "demo" && item.status === "active" && item.canTrade), [accounts]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [form, setForm] = useState({ exchangeAccountId: "", communityStrategyId: "", symbol: "BTCUSDT", side: "buy", quantity: "0.001" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm((value) => ({ ...value, exchangeAccountId: value.exchangeAccountId || eligible[0]?.id || "" }));
  }, [eligible]);

  useEffect(() => {
    void fetch("/api/strategy-marketplace", { cache: "no-store" }).then(async (response) => {
      const result = safeJson<{ mine?: Strategy[] }>(await response.text());
      if (!response.ok) return;
      setStrategies((result?.mine || []).filter((item) => ["draft", "testing", "rejected"].includes(item.status)));
    }).catch(() => {});
  }, []);

  function chooseStrategy(id: string) {
    const strategy = strategies.find((item) => item.id === id);
    const first = String(strategy?.symbols?.[0] || "BTCUSDT").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    setForm((value) => ({ ...value, communityStrategyId: id, symbol: first }));
  }

  async function submit() {
    if (!form.communityStrategyId) {
      setMessage("请选择需要进行模拟测试的策略草稿。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/simulated-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, quantity: Number(form.quantity) }),
      });
      const result = safeJson<{ error?: string; message?: string; fillPrice?: number }>(await response.text());
      setMessage(result?.error || `${result?.message || "策略测试已提交"}${result?.fillPrice ? ` · 参考价 ${result.fillPrice}` : ""}`);
      if (response.ok) onDone();
    } catch {
      setMessage("策略测试服务暂不可用。");
    } finally {
      setBusy(false);
    }
  }

  if (!eligible.length) return null;
  return <section className="wide-panel simulated-order-panel">
    <div className="widget-head"><b>我的策略模拟测试</b><span>仅测试本人策略 · 不发送真实订单</span></div>
    <div className="order-form-grid">
      <select value={form.exchangeAccountId} onChange={(event) => setForm({ ...form, exchangeAccountId: event.target.value })}>{eligible.map((account) => <option key={account.id} value={account.id}>{account.exchange} · {account.label}</option>)}</select>
      <select value={form.communityStrategyId} onChange={(event) => chooseStrategy(event.target.value)}><option value="">选择我的待测策略</option>{strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name} · V{strategy.version}</option>)}</select>
      <select value={form.symbol} onChange={(event) => setForm({ ...form, symbol: event.target.value })}>{["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","TRXUSDT"].map((symbol) => <option key={symbol}>{symbol}</option>)}</select>
      <select value={form.side} onChange={(event) => setForm({ ...form, side: event.target.value })}><option value="buy">买入</option><option value="sell">卖出</option></select>
      <input value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} placeholder="数量" />
      <button className="primary" disabled={!allowed || busy || !form.exchangeAccountId} onClick={() => void submit()}>{busy ? "正在测试…" : "提交策略测试"}</button>
    </div>
    <small className="form-message">{message || "参考价格由后台行情源读取，不能由客户填写。该入口只用于验证你自己创建的策略，不影响策略保存或发布。"}</small>
  </section>;
}
