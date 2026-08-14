"use client";

import { useEffect, useState } from "react";
import ExchangeLogo from "./exchange-logo";

type ExchangeInfo = {
  key: string;
  displayName: string;
  supportsSpot: boolean;
  supportsContracts: boolean;
  contractNote?: string;
};

type AdapterStatus = {
  key: string;
  demoVerificationReady: boolean;
  permissionCheckReady: boolean;
  orderRoutingReady: boolean;
  mode: "demo+live" | "registered";
  note: string;
};

const orderOperationLabels: Record<string, string> = {
  place: "下单",
  cancel: "撤单",
  fills: "成交同步",
  positions: "持仓同步",
};

const fallbackExchanges: ExchangeInfo[] = [
  { key: "OKX", displayName: "OKX", supportsSpot: true, supportsContracts: true },
  { key: "BINANCE", displayName: "BINANCE", supportsSpot: true, supportsContracts: true },
  { key: "BYBIT", displayName: "BYBIT", supportsSpot: true, supportsContracts: true },
  { key: "BITGET", displayName: "BITGET", supportsSpot: true, supportsContracts: true },
  { key: "GATE.IO", displayName: "GATE.IO", supportsSpot: true, supportsContracts: true },
  { key: "KUCOIN", displayName: "KUCOIN", supportsSpot: true, supportsContracts: true },
  { key: "COINBASE", displayName: "COINBASE", supportsSpot: true, supportsContracts: false, contractNote: "仅现货" },
  { key: "KRAKEN", displayName: "KRAKEN", supportsSpot: true, supportsContracts: false, contractNote: "当前仅现货" },
];

type Environment = "demo" | "live";
type FormState = {
  label: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
  canTrade: boolean;
  withdrawalAuthorized: boolean;
};

const emptyForm: FormState = {
  label: "",
  apiKey: "",
  secretKey: "",
  passphrase: "",
  canTrade: false,
  withdrawalAuthorized: false,
};

export default function ConnectLive() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [exchangeCatalog, setExchangeCatalog] = useState<ExchangeInfo[]>(fallbackExchanges);
  const [adapterStatus, setAdapterStatus] = useState<AdapterStatus[]>([]);
  const [selected, setSelected] = useState("OKX");
  const [environment, setEnvironment] = useState<Environment>("demo");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);

  const load = () =>
    fetch("/api/exchange-accounts")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        setAccounts(data?.accounts || []);
        if (Array.isArray(data?.supportedExchanges) && data.supportedExchanges.length) {
          setExchangeCatalog(data.supportedExchanges);
        }
        if (Array.isArray(data?.adapterStatus)) setAdapterStatus(data.adapterStatus);
      })
      .catch(() => {
        setAccounts([]);
        setAdapterStatus([]);
      });

  useEffect(() => {
    void load();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/exchange-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        exchange: selected,
        environment,
        ...form,
        canRead: true,
      }),
    });
    const data = await response.json();
    setMessage(data.error || data.message || "已提交");
    if (response.ok) {
      setForm(emptyForm);
      void load();
    }
  }

  async function action(id: string, actionName: string) {
    const response = await fetch(`/api/exchange-accounts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: actionName }),
    });
    const data = await response.json();
    setMessage(data.error || data.message || "操作完成");
    if (response.ok) void load();
  }

  function selectExchange(exchange: string) {
    setSelected(exchange);
    if (!adapterStatus.find((item) => item.key === exchange)?.permissionCheckReady) {
      setEnvironment("demo");
    }
    setMessage("");
  }

  const selectedAdapter = adapterStatus.find((item) => item.key === selected);
  const channelNote = !selectedAdapter?.permissionCheckReady
    ? "该交易所的官方权限检测尚未接入，当前只能使用本地模拟盘。"
    : selectedAdapter.orderRoutingReady
      ? "官方鉴权与模拟订单链路已接入；真实下单仍需风险检查和明确的实盘开关。"
      : "官方鉴权已接入；下单、撤单、成交同步和持仓同步仍待该交易所沙盒验证，当前不会发送订单。";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>连接交易所</h1>
          <p>支持八大主流交易所 · 凭证加密保存，资金始终留在你的交易所账户</p>
        </div>
      </div>

      <div className="connect-grid">
        {exchangeCatalog.map((exchange) => {
          const name = exchange.key;
          const account = accounts.find((item) => item.exchange === name);
          const adapter = adapterStatus.find((item) => item.key === name);
          const description = exchange.supportsContracts ? "现货与合约" : (exchange.contractNote || "仅现货");
          return (
            <article className="exchange" key={name}>
              <ExchangeLogo name={name} />
              <div>
                <h2>{exchange.displayName}</h2>
                <p>{account ? `${account.environment === "demo" ? "模拟盘" : "实盘"} · ${account.status}` : description}</p>
                <small className="exchange-capability-summary">
                  {exchange.supportsContracts ? "合约可用" : "仅现货"} · {adapter?.permissionCheckReady ? "鉴权已接入" : "鉴权待接入"} · {adapter?.demoVerificationReady ? "模拟盘可用" : "模拟盘待接入"} · {adapter?.orderRoutingReady ? "订单链路已接入" : "订单链路待沙盒验证"}
                </small>
              </div>
              <span className={account?.status === "active" ? "green" : ""}>
                {account?.status === "active" ? "已启用" : account ? "待检测" : "未连接"}
              </span>
              <button type="button" onClick={() => selectExchange(name)}>{account ? "管理连接" : "连接"}</button>
            </article>
          );
        })}
      </div>

      <section className="wide-panel exchange-live-panel">
        <div className="widget-head">
          <b>{environment === "live" ? "新增实盘连接" : "新增模拟盘连接"} · {selected}</b>
          <span>{environment === "live" ? "仅先做凭证与权限检测" : "先验证，再允许交易"}</span>
        </div>

        <div className="environment-switch" role="group" aria-label="账户环境">
          <button type="button" className={environment === "demo" ? "active" : ""} onClick={() => setEnvironment("demo")}>模拟盘</button>
          <button type="button" className={environment === "live" ? "active" : ""} onClick={() => setEnvironment("live")} disabled={!adapterStatus.find((item) => item.key === selected)?.permissionCheckReady}>实盘</button>
        </div>
        <p className="live-channel-note">
          {channelNote}
        </p>

        <form className="exchange-connect-form" onSubmit={submit}>
          <input placeholder="账户标签（可选）" value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          <input required placeholder="API Key" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
          <input required type="password" placeholder="Secret Key" value={form.secretKey} onChange={(event) => setForm({ ...form, secretKey: event.target.value })} />
          {["OKX", "BITGET", "KUCOIN"].includes(selected) && <input required placeholder={`${selected} Passphrase`} value={form.passphrase} onChange={(event) => setForm({ ...form, passphrase: event.target.value })} />}
          {selected === "COINBASE" && <p className="field-hint">Coinbase Secret Key 请粘贴包含 BEGIN PRIVATE KEY 的 CDP 私钥。</p>}
          <label><input type="checkbox" checked={form.canTrade} onChange={(event) => setForm({ ...form, canTrade: event.target.checked })} /> 允许交易权限检测</label>
          <label><input type="checkbox" checked={form.withdrawalAuthorized} onChange={(event) => setForm({ ...form, withdrawalAuthorized: event.target.checked })} /> 客户主动开启提现授权</label>
          <button className="primary">加密保存并检测</button>
        </form>
        {message && <p className="admin-notice">{message}</p>}
      </section>

      <section className="wide-panel">
        <h2>已连接账户</h2>
        {accounts.length ? accounts.map((account) => (
          <div className="service service-exchange-account" key={account.id}>
            <div className="service-main">
              <span><i />{account.exchange} · {account.label}</span>
              <b>{account.environment === "demo" ? "模拟盘" : "实盘"} · {account.status}</b>
            </div>
            <small className={`exchange-routing-badge ${account.routing?.ready ? "is-ready" : ""}`}>
              {account.routing?.ready ? "模拟订单链路已就绪" : account.routing?.code === "EXCHANGE_LIVE_DISABLED" ? "实盘订单已关闭" : "待沙盒验证"}
            </small>
            <div className="exchange-routing-detail">
              <span>{account.routing?.reason || "已保存凭证，等待连接状态同步"}</span>
              <div className="exchange-operation-list">
                {(account.routing?.supportedOperations || []).map((operation: string) => (
                  <em key={operation}>{orderOperationLabels[operation] || operation}</em>
                ))}
                {!(account.routing?.supportedOperations || []).length && <em className="is-pending">下单能力待验证</em>}
              </div>
              {account.routing?.adapter?.docsUrl && <a href={account.routing.adapter.docsUrl} target="_blank" rel="noreferrer">官方接口文档 ↗</a>}
              {account.routing?.adapter?.testnetUrl && <a href={account.routing.adapter.testnetUrl} target="_blank" rel="noreferrer">沙盒文档 ↗</a>}
            </div>
            <div className="service-actions">
              <button type="button" onClick={() => void action(account.id, "check")}>权限检测</button>{" "}
              <button type="button" onClick={() => void action(account.id, "disconnect")}>断开</button>
            </div>
          </div>
        )) : <p>暂无已保存连接。请先完成邮箱验证。</p>}
      </section>
    </>
  );
}
