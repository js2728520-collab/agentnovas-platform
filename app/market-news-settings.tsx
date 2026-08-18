"use client";

import { useEffect, useMemo, useState } from "react";
import { SystemLlmConfigPanel } from "./llm-config";
import { AgentRoleAdmin } from "./agent-role-admin";

type IntegrationItem = {
  id: string;
  category: "market" | "news" | "ai" | "search";
  name: string;
  description: string;
  freeTier: string;
  requiresKey: boolean;
  envKeys: string[];
  docsUrl: string;
  status: "wired" | "ready-to-configure" | "catalog-only";
  serverOnly: boolean;
  configured: boolean;
};

const categoryLabels: Record<IntegrationItem["category"], string> = {
  market: "行情数据",
  news: "新闻与事件",
  ai: "大模型",
  search: "搜索与研究",
};

const statusLabels: Record<IntegrationItem["status"], string> = {
  wired: "已接入",
  "ready-to-configure": "可配置",
  "catalog-only": "目录预留",
};

export default function MarketNewsSettings(){
  const [saved,setSaved]=useState(false);
  const [catalog,setCatalog]=useState<IntegrationItem[]>([]);

  useEffect(() => {
    let active = true;
    fetch("/api/integrations/catalog", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { integrations?: IntegrationItem[] } | null) => {
        if (active && payload?.integrations) setCatalog(payload.integrations);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const groupedCatalog = useMemo(() => {
    return (Object.keys(categoryLabels) as IntegrationItem["category"][]).map((category) => ({
      category,
      items: catalog.filter((item) => item.category === category),
    })).filter((group) => group.items.length > 0);
  }, [catalog]);

  return <section className="market-news-settings">
    <div className="market-news-head"><div><span className="eyebrow">DATA & NEWS INTEGRATIONS</span><h2>行情与新闻 API</h2><p>这里集中查看当前实时数据源。切换供应商时，只需在本地环境变量或线上 Worker 变量中更新。</p></div><span className="integration-live"><i/>当前接口可用</span></div>
    <div className="integration-grid">
      <article className="integration-card"><span className="integration-icon">↗</span><div><b>实时行情</b><small>币种报价、涨跌幅与行情雷达</small></div><strong>Binance Spot REST · 自动切换</strong><code>/api/market/ticker</code><label>官方公共节点<input value="data-api → api-gcp → api.binance.com" readOnly/></label><div className="integration-status"><i/>多节点故障转移 · 无需 API Key</div></article>
      <article className="integration-card"><span className="integration-icon">✦</span><div><b>市场新闻</b><small>市场快讯与交易所公告</small></div><strong>CoinDesk + Cointelegraph RSS</strong><code>/api/market/news</code><label>新闻源<input value="CoinDesk RSS / Cointelegraph RSS" readOnly/></label><div className="integration-status"><i/>自动刷新 · 当前无需 API Key</div></article>
    </div>
    <div className="integration-env"><span className="eyebrow">CONFIGURATION LOCATION</span><h3>更换供应商时填写这里</h3><p>本地开发：项目根目录的 <code>.env</code>；上线后：Cloudflare Worker → 设置 → 变量和机密。密钥只放服务端，浏览器和客户页面不会读取。</p><div className="env-tags"><code>MARKET_DATA_BASE_URL</code><code>MARKET_DATA_PROVIDER</code><code>MARKET_DATA_TICKER_PATH</code><code>NEWS_RSS_URLS</code><code>AI_API_URL</code><code>AI_API_KEY</code><code>AI_MODEL</code></div></div>
    <SystemLlmConfigPanel/>
    <AgentRoleAdmin/>
    {groupedCatalog.length > 0 && <div className="integration-catalog">
      <div className="integration-catalog-head"><div><span className="eyebrow">AVAILABLE CONNECTORS</span><h3>免费与可申请接口目录</h3><p>先登记供应商和用途，再由管理员把申请到的 Key 配置到服务端。免费额度不代表无限调用。</p></div><span className="catalog-count">{catalog.length} 个接口</span></div>
      <div className="integration-catalog-groups">
        {groupedCatalog.map(({ category, items }) => <div className="integration-catalog-group" key={category}>
          <div className="integration-catalog-label">{categoryLabels[category]}</div>
          <div className="integration-provider-grid">
            {items.map((item) => <article className="integration-provider-card" key={item.id}>
              <div className="integration-provider-top"><strong>{item.name}</strong><span className={`integration-provider-status is-${item.status}`}>{statusLabels[item.status]}</span></div>
              <p>{item.description}</p>
              <small>{item.freeTier}</small>
              <div className="integration-provider-foot"><span>{item.configured ? "已检测到配置" : item.requiresKey ? "等待填写 Key" : "无需 Key"}</span><a href={item.docsUrl} target="_blank" rel="noreferrer">申请/文档 ↗</a></div>
              <div className="integration-provider-env">{item.envKeys.map((key) => <code key={key}>{key}</code>)}</div>
            </article>)}
          </div>
        </div>)}
      </div>
    </div>}
    <div className="integration-actions"><button className="primary" onClick={()=>{setSaved(true);window.setTimeout(()=>setSaved(false),2200)}}>保存接口说明</button>{saved&&<span className="save-success">已保存</span>}</div>
  </section>
}
