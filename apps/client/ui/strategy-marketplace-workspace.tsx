"use client";

import { useMemo, useState } from "react";

import { apiErrorMessage } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import styles from "./strategy-marketplace.module.css";

type Backtest = {
  netReturnPct: number | null;
  maxDrawdownPct: number | null;
  winRatePct: number | null;
  sampleSize: number | null;
  periodStart: string | null;
  periodEnd: string | null;
};

type Strategy = {
  id: string;
  name: string;
  summary: string;
  /** 作者的展示身份。**没有邮箱**——广场对未登录访客开放。 */
  authorNickname: string | null;
  authorUsername: string | null;
  isPlatformAuthor: boolean;
  riskLevel: "low" | "medium" | "high";
  symbols: string[];
  activeFollowers: number;
  publishedAt: string | null;
  backtests: Backtest[];
};

type MarketplacePayload = { published?: Strategy[] };

const riskLabels: Record<string, string> = { low: "保守", medium: "平衡", high: "激进" };

/** 与服务端 follow 路由里的披露正文对应。客户确认的是这三条。 */
const DISCLOSURE = [
  "模拟跟单不产生真实订单，盈亏为服务器记账结果，不可提取。",
  "策略表现不代表未来收益；作者可能修改或下架策略。",
  "绩效分成按 UTC 自然周与高水位线结算，亏损周不计费。",
];

function backtestPeriod(backtest: Backtest | undefined) {
  if (!backtest?.periodStart || !backtest.periodEnd) return "回测区间：未记录";
  return `回测区间：${backtest.periodStart.slice(0, 10)} 至 ${backtest.periodEnd.slice(0, 10)}`;
}

function pct(value: number | null | undefined) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : "—";
}

export default function StrategyMarketplaceWorkspace() {
  const resource = useApiData<MarketplacePayload>("/api/strategy-marketplace", "策略广场读取失败");
  const [selectedId, setSelectedId] = useState("");
  const published = useMemo(() => resource.data?.published ?? [], [resource.data]);
  const selected = published.find((item) => item.id === selectedId) ?? published[0] ?? null;

  if (resource.loading && !resource.data) return <LoadingState label="正在读取策略广场…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;

  return <div className={styles.page}>
    <PageHeading eyebrow="STRATEGY MARKETPLACE" title="策略广场" description="浏览已上架策略并开启模拟跟单。跟单为服务器记账的模拟成交，不产生真实订单。" />
    {published.length === 0
      ? <EmptyState title="暂无已上架策略" description="策略通过平台审核并上架后会出现在这里。" />
      : <div className={styles.layout}>
        <div className={styles.list}>
          {published.map((strategy) => {
            const latest = strategy.backtests[0];
            return <button
              type="button"
              key={strategy.id}
              className={styles.card}
              data-selected={strategy.id === selected?.id}
              onClick={() => setSelectedId(strategy.id)}
            >
              <span className={styles.cardHead}>
                <span className={styles.cardName}>{strategy.name}</span>
                <span className={styles.cardAuthor}>
                  {strategy.isPlatformAuthor ? "平台自营" : (strategy.authorNickname || strategy.authorUsername || "平台用户")}
                  {" · "}{riskLabels[strategy.riskLevel] ?? strategy.riskLevel}
                  {" · "}{strategy.activeFollowers} 人跟随
                </span>
              </span>
              <span className={styles.cardSummary}>{strategy.summary}</span>
              <span className={styles.metrics}>
                <span className={styles.metric}>
                  <small>净收益</small>
                  <b className={Number(latest?.netReturnPct) >= 0 ? styles.up : styles.down}>{pct(latest?.netReturnPct)}</b>
                </span>
                <span className={styles.metric}><small>最大回撤</small><b>{pct(latest?.maxDrawdownPct)}</b></span>
                <span className={styles.metric}><small>胜率</small><b>{pct(latest?.winRatePct)}</b></span>
                <span className={styles.metric}><small>样本</small><b>{latest?.sampleSize ?? "—"}</b></span>
              </span>
            </button>;
          })}
        </div>
        {selected && <FollowPanel strategy={selected} onFollowed={resource.refresh} />}
      </div>}
  </div>;
}

function FollowPanel({ strategy, onFollowed }: { strategy: Strategy; onFollowed: () => Promise<void> }) {
  const [capitalPct, setCapitalPct] = useState("3");
  const [stopLossPct, setStopLossPct] = useState("10");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");

  const capital = Number(capitalPct);
  const stopLoss = Number(stopLossPct);
  const valid = Number.isFinite(capital) && capital > 0 && capital <= 100
    && Number.isFinite(stopLoss) && stopLoss > 0 && stopLoss <= 100;

  async function follow() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/strategy-marketplace/${encodeURIComponent(strategy.id)}/follow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capitalPct: capital, stopLossPct: stopLoss, acceptDisclosure: accepted }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(body, "开启跟单失败"));
      setMessageKind("success");
      setMessage(body.replayed
        ? "你已经在跟随这个策略了。"
        : "已确认跟单，首个决策周期开始后进入运行中。");
      await onFollowed();
    } catch (error) {
      setMessageKind("error");
      // 失败时不改本地状态：显示一个没有生效的跟单，比报错更糟。
      setMessage(error instanceof Error ? error.message : "开启跟单失败");
    } finally { setBusy(false); }
  }

  return <section className={styles.detail}>
    <div className={styles.detailHead}>
      <h2>{strategy.name}</h2>
      <p>{strategy.summary}</p>
      <p>交易品种：{strategy.symbols.join("、") || "—"}</p>
      {/* 只展示历史表现，不展示策略逻辑（需求方 2026-08-24 确认：不公开 DSL）。
          公开条件树等于让人不跟单就能抄走策略。 */}
      <p>{backtestPeriod(strategy.backtests[0])}</p>
    </div>

    <div className={styles.metrics}>
      <span className={styles.metric}><small>跟随人数</small><b>{strategy.activeFollowers}</b></span>
      <span className={styles.metric}>
        <small>回测净收益</small>
        <b className={Number(strategy.backtests[0]?.netReturnPct) >= 0 ? styles.up : styles.down}>
          {pct(strategy.backtests[0]?.netReturnPct)}
        </b>
      </span>
      <span className={styles.metric}><small>最大回撤</small><b>{pct(strategy.backtests[0]?.maxDrawdownPct)}</b></span>
      <span className={styles.metric}><small>胜率</small><b>{pct(strategy.backtests[0]?.winRatePct)}</b></span>
      <span className={styles.metric}><small>成交样本</small><b>{strategy.backtests[0]?.sampleSize ?? "—"}</b></span>
    </div>

    <label className={styles.field}>
      每单占比（%）
      <input type="number" min={0.1} max={100} step={0.1} value={capitalPct}
        onChange={(event) => setCapitalPct(event.target.value)} />
      <small>每笔开仓占模拟盘本金的比例。模拟盘本金为 10,000 USDT。</small>
    </label>
    <label className={styles.field}>
      止损线（%）
      <input type="number" min={0.1} max={100} step={0.1} value={stopLossPct}
        onChange={(event) => setStopLossPct(event.target.value)} />
      {/* 这个数字就是自动风控的停机线——客户同意的是它，不是某个他没看过的平台阈值。 */}
      <small>累计回撤触及这条线时，系统自动阻断该跟单的新开仓。</small>
    </label>

    <div className={styles.disclosure}>
      <b>跟单风险披露</b>
      <ul>{DISCLOSURE.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
    <label className={styles.consent}>
      <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
      <span>我已阅读并理解上述风险披露</span>
    </label>

    {message && <p className={styles.message} data-kind={messageKind} role="status">{message}</p>}

    <div className="rc-action-row">
      {/* 未勾选披露时按钮不可用——默认同意等于没有确认。 */}
      <button className="rc-primary" type="button" disabled={busy || !accepted || !valid} onClick={() => void follow()}>
        {busy ? "正在开启…" : "开启模拟跟单"}
      </button>
    </div>
  </section>;
}
