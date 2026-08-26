"use client";

import { formatDateTime } from "@/packages/contracts/src/riverton-ui";
import { EmptyState, ErrorState, LoadingState, PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";
import styles from "./follow-results.module.css";

type Fill = {
  symbol: string; action: "buy" | "sell"; quantity: string; fillPrice: string;
  feeUsdt: string; realizedNetPnlUsdt: string; filledAt: string;
};

type Stage = { sequence: number; role: string; conclusion: string; llmUsed: boolean };

type Cycle = {
  candleCloseTime: string;
  traceId: string;
  action: string | null;
  riskApproved: boolean | null;
  rejectionReasons: string[];
  stages: Stage[];
};

type Follow = {
  subscriptionId: string;
  status: "configuring" | "user_confirmed" | "active" | "paused" | "risk_blocked" | "stopped";
  pausedBy: string | null;
  pausedReason: string | null;
  capitalPct: number;
  stopLossPct: number;
  strategyName: string;
  listingStatus: string;
  performanceFeeBps: number | null;
  portfolio: {
    principalUsdt: string; cashUsdt: string; realizedNetPnlUsdt: string; feesUsdt: string;
    positions: Array<{ symbol: string; quantity: string; averageEntryPrice: string; costBasisUsdt: string }>;
    fills: Fill[];
  } | null;
  cycles: Cycle[];
};

/** 客户能自己恢复的只有自己暂停的那种。其余三方造成的阻断要找运营（PRD 6.6）。 */
const authorityLabels: Record<string, string> = {
  customer: "你自己",
  operations_risk: "运营风控",
  automated_risk: "系统自动风控",
  global_circuit_breaker: "全局熔断",
};

/** 七阶段的中文名。顺序固定，缺阶段要标 partial（INV-8）。 */
const stageLabels: Record<string, string> = {
  market_data: "行情数据",
  technical_analysis: "技术分析",
  strategy_decision: "策略判断",
  adversarial_review: "反方审查",
  risk: "风控",
  decision: "决策",
  execution: "执行",
};

const actionLabels: Record<string, string> = {
  enter_long: "开多", exit: "离场", hold: "持仓不动",
};

const statusNotes: Record<string, string> = {
  configuring: "尚未确认参数。",
  user_confirmed: "已确认，等待首个决策周期开始。",
  active: "运行中。",
  paused: "已暂停，你可以随时恢复。",
  risk_blocked: "被风控阻断，暂停开新仓；已有持仓仍可离场。",
  stopped: "已终止。",
};

function money(value: string | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "—";
}

export default function FollowResultsWorkspace() {
  const resource = useApiData<{ follows: Follow[]; paperChargesFees: boolean }>(
    "/api/strategy-follows", "跟单结果读取失败");
  if (resource.loading && !resource.data) return <LoadingState label="正在读取跟单结果…" />;
  if (resource.error && !resource.data) return <ErrorState message={resource.error} retry={resource.refresh} />;
  const follows = resource.data?.follows ?? [];

  return <div className={styles.page}>
    <PageHeading eyebrow="MY FOLLOWS" title="我的跟单"
      description="模拟跟单的持仓与成交。盈亏为服务器记账结果，不产生真实订单，也不可提取。" />
    {follows.length === 0
      ? <EmptyState title="还没有跟单" description="到策略广场挑一个已上架的策略开始模拟跟单。" />
      : <div className={styles.list}>{follows.map((follow) => <FollowCard key={follow.subscriptionId} follow={follow} />)}</div>}
  </div>;
}

function FollowCard({ follow }: { follow: Follow }) {
  const portfolio = follow.portfolio;
  const pnl = Number(portfolio?.realizedNetPnlUsdt ?? 0);
  const equity = Number(portfolio?.cashUsdt ?? 0)
    + (portfolio?.positions ?? []).reduce((sum, position) => sum + Number(position.costBasisUsdt), 0);

  return <article className={styles.follow}>
    <div className={styles.head}>
      <span className={styles.name}>{follow.strategyName}</span>
      <StatusBadge value={follow.status} />
    </div>

    {/* 被风控停了必须说清是谁停的、能不能自己恢复——否则客户只会看到「不开仓」。 */}
    {follow.status === "risk_blocked" && <div className={styles.blocked}>
      <b>该跟单已被{authorityLabels[follow.pausedBy ?? ""] ?? "风控"}阻断</b>
      <span>{follow.pausedReason ?? "未记录原因"}</span>
      <span>新开仓已停止，已有持仓仍可离场。恢复需要联系运营风控。</span>
    </div>}

    <p className={styles.note}>
      {statusNotes[follow.status] ?? ""} 每单占比 {follow.capitalPct}%，止损线 {follow.stopLossPct}%。
      不设置单独的固定止盈线；离场由已确认策略版本中的离场条件决定。
    </p>

    {portfolio && <>
      <div className={styles.stats}>
        <span className={styles.stat}><small>模拟本金</small><b>{money(portfolio.principalUsdt)}</b></span>
        <span className={styles.stat}><small>当前权益</small><b>{equity.toFixed(2)}</b></span>
        <span className={styles.stat}>
          <small>已实现盈亏</small>
          <b className={pnl >= 0 ? styles.up : styles.down}>{pnl >= 0 ? "+" : ""}{money(portfolio.realizedNetPnlUsdt)}</b>
        </span>
        <span className={styles.stat}><small>累计手续费</small><b>{money(portfolio.feesUsdt)}</b></span>
        <span className={styles.stat}><small>持仓</small><b>{portfolio.positions.length}</b></span>
      </div>
      {/* paper 不收费（P-06）。不说清楚，客户看到合同里的费率会以为在扣钱。 */}
      <p className={styles.note}>
        模拟跟单不收取绩效分成。合同记录的费率
        {follow.performanceFeeBps === null ? "尚未确定" : ` ${(follow.performanceFeeBps / 100).toFixed(0)}%`}
        将在实盘跟单开放后才适用。
      </p>

      {follow.cycles.length > 0 && <details className={styles.cycles}>
        <summary>决策记录（最近 {follow.cycles.length} 轮）</summary>
        {follow.cycles.map((cycle) => <div className={styles.cycle} key={cycle.traceId}>
          <div className={styles.cycleHead}>
            <span>{formatDateTime(cycle.candleCloseTime)}</span>
            <span>{actionLabels[cycle.action ?? ""] ?? cycle.action ?? "—"}</span>
          </div>
          {/* 被拒的理由是最需要看的——它解释了「为什么这一轮没动」。 */}
          {cycle.rejectionReasons.length > 0 && <ul className={styles.reasons}>
            {cycle.rejectionReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>}
          <ol className={styles.stages}>
            {cycle.stages.map((stage) => <li key={stage.sequence}>
              <b>{stageLabels[stage.role] ?? stage.role}</b>
              <span>{stage.conclusion}</span>
              {/* 确定性代码与模型解释要分得清（INV-1）。 */}
              {stage.llmUsed && <em>模型解释</em>}
            </li>)}
          </ol>
          {cycle.stages.length < 7 && <p className={styles.partial}>
            本轮只记录了 {cycle.stages.length} 个阶段，叙述不完整。
          </p>}
        </div>)}
      </details>}

      {portfolio.fills.length > 0 && <table className={styles.fills}>
        <thead><tr><th>时间</th><th>品种</th><th>方向</th><th>数量</th><th>成交价</th><th>手续费</th><th>已实现盈亏</th></tr></thead>
        <tbody>
          {portfolio.fills.slice(0, 20).map((fill, index) => <tr key={`${fill.filledAt}-${index}`}>
            <td>{formatDateTime(fill.filledAt)}</td>
            <td>{fill.symbol}</td>
            <td>{fill.action === "buy" ? "买入" : "卖出"}</td>
            <td>{fill.quantity}</td>
            <td>{money(fill.fillPrice)}</td>
            <td>{money(fill.feeUsdt)}</td>
            <td className={Number(fill.realizedNetPnlUsdt) >= 0 ? styles.up : styles.down}>
              {fill.action === "buy" ? "—" : money(fill.realizedNetPnlUsdt)}
            </td>
          </tr>)}
        </tbody>
      </table>}
    </>}
  </article>;
}
