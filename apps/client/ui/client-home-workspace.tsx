"use client";

import Link from "next/link";

import type {
  AiCreditBalance,
  CursorPage,
  MembershipEntitlement,
  MembershipOrder,
  PaperPortfolio,
  PerformanceFeeStatement,
} from "@/packages/contracts/src/commercial-beta";
import {
  formatDateTime,
  formatDecimal,
  hasAnyPermission,
  type EffectiveAccessPayload,
  type ViewerPayload,
} from "@/packages/contracts/src/riverton-ui";
import { useApiData } from "@/packages/ui/src/use-api-data";

import { deriveClientHomeTask, derivePaperPortfolioSummary } from "./client-home-model";
import { ClientPortalShell } from "./client-portal-shell";
import styles from "./client-home-workspace.module.css";

const modules = [
  { href: "/workspace", permission: "client.paper.view", title: "策略实验室", description: "创建策略、运行历史回测并管理模拟部署。", accent: "RESEARCH" },
  { href: "/wallet", permission: "client.wallet.view", title: "资产与账本", description: "查看服务余额、资金方向和不可变流水。", accent: "ASSETS" },
  { href: "/credits", permission: "client.credits.view", title: "AI 积分", description: "查看模型调用可用额度、预留与消耗记录。", accent: "CREDITS" },
  { href: "/performance-statements", permission: "client.membership.view", title: "绩效账单", description: "查看已结束 Paper 周期的账单与处理状态。", accent: "STATEMENTS" },
] as const;

const strategyLabels = {
  ai_conservative: "AI 稳健型",
  ai_balanced: "AI 平衡型",
  ai_aggressive: "AI 激进型",
} as const;
const portfolioStatusLabels = { ACTIVE: "可开仓", CLOSE_ONLY: "仅平仓", READ_ONLY: "只读" } as const;
const runtimeLabels = { NOT_STARTED: "未启动", ACTIVE: "运行中", PAUSED: "已暂停", ENDED: "已结束", FAILED: "异常" } as const;
const membershipLabels: Record<string, string> = {
  TRIAL: "试用中", ACTIVE: "生效中", GRACE: "宽限期", READ_ONLY: "只读", EXPIRED: "已到期", CANCELLED: "已取消",
};
const orderLabels: Record<string, string> = {
  AWAITING_EVIDENCE: "等待凭证", SUBMITTED: "人工复核中", REJECTED: "审核未通过", ACTIVATED: "已激活", CANCELLED: "已取消",
};
const statementLabels: Record<string, string> = {
  SUBMITTED: "等待审批", APPROVED: "审批已记录", REJECTED: "审核未通过", INVOICED: "等待付款复核", PAID: "已完成", CLOSED_NO_FEE: "无需支付",
};

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function pnlClass(value: number | string) {
  return Number(value) < 0 ? styles.negative : styles.positive;
}

function StatusCard({ label, value, detail, state, retry }: {
  label: string;
  value: string;
  detail: string;
  state?: "loading" | "error";
  retry?: () => void;
}) {
  return <article className={styles.statusCard} aria-busy={state === "loading" || undefined} role={state === "error" ? "alert" : undefined}>
    <span>{label}</span>
    <strong>{value}</strong>
    <p>{detail}</p>
    {state === "error" && retry && <button type="button" onClick={retry}>重新读取</button>}
  </article>;
}

export function ClientHomeWorkspace({ viewer, access }: { viewer: ViewerPayload; access: EffectiveAccessPayload }) {
  const canViewMembership = hasAnyPermission(access.permissions, ["client.membership.view"]);
  const canViewCredits = hasAnyPermission(access.permissions, ["client.credits.view"]);
  const canViewPaper = hasAnyPermission(access.permissions, ["client.paper.view"]);
  const membership = useApiData<{ membership: MembershipEntitlement | null }>(canViewMembership ? "/api/membership/me" : null, "会员状态读取失败");
  const orders = useApiData<CursorPage<MembershipOrder>>(canViewMembership ? "/api/membership/orders?limit=1" : null, "会员申请读取失败");
  const statements = useApiData<CursorPage<PerformanceFeeStatement>>(canViewMembership ? "/api/membership/performance-statements?limit=1" : null, "绩效账单读取失败");
  const credits = useApiData<{ credits: AiCreditBalance }>(canViewCredits ? "/api/credits/me" : null, "AI 积分读取失败");
  const paper = useApiData<{ data: PaperPortfolio[] }>(canViewPaper ? "/api/trading-hall/paper/portfolio" : null, "模拟组合读取失败");
  const notifications = useApiData<{ unread: number }>("/api/notifications/inbox?summary=1", "未读通知读取失败");
  const visibleModules = modules.filter((module) => hasAnyPermission(access.permissions, [module.permission]));
  const portfolioSummary = derivePaperPortfolioSummary(paper.data?.data ?? []);
  const task = deriveClientHomeTask({
    canViewMembership,
    membership: membership.data?.membership,
    membershipError: membership.error,
    latestOrder: orders.data ? orders.data.data[0] ?? null : undefined,
    latestOrderError: orders.error,
    canViewPaper,
    portfolios: paper.data?.data,
    portfolioError: paper.error,
  });
  const displayName = viewer.nickname || viewer.username || viewer.email.split("@")[0];

  return <ClientPortalShell viewer={viewer} access={access}>
    <header className={styles.hero}>
      <div>
        <span className={styles.eyebrow}>PERSONAL PAPER TRADING DESK</span>
        <h1>{displayName}，欢迎回来</h1>
        <p>从三张官方现货策略查看组合表现、七智能体决策和模拟成交。页面只展示当前账户的服务端数据。</p>
      </div>
      <div className={styles.heroActions}>
        {canViewPaper && <Link className={styles.primaryAction} href="/trading-hall">进入交易大厅</Link>}
        {canViewPaper && <Link className={styles.secondaryAction} href="/paper">查看模拟组合</Link>}
      </div>
    </header>

    <section className={styles.portfolioOverview} aria-labelledby="portfolio-overview-title">
      <div className={styles.equityCard} aria-busy={paper.loading || undefined}>
        <span className={styles.eyebrow}>PORTFOLIO OVERVIEW</span>
        <h2 id="portfolio-overview-title">组合总权益</h2>
        {paper.error ? <><strong className={styles.unavailable}>读取失败</strong><p role="alert">{paper.error}</p><button type="button" onClick={paper.refresh}>重新读取</button></>
          : paper.loading || !paper.data ? <><strong className={styles.unavailable}>正在读取</strong><p>正在汇总当前账户的官方模拟组合</p></>
            : <>
              <strong>{money(portfolioSummary.totalEquityUsdt)} <small>USDT</small></strong>
              <div className={styles.pnlRow}>
                <span>已实现净收益 <b className={pnlClass(portfolioSummary.realizedNetPnlUsdt)}>{money(portfolioSummary.realizedNetPnlUsdt)}</b></span>
                <span>未实现收益 <b className={pnlClass(portfolioSummary.unrealizedPnlUsdt)}>{money(portfolioSummary.unrealizedPnlUsdt)}</b></span>
              </div>
            </>}
      </div>
      <div className={styles.portfolioStats}>
        <article><span>官方策略</span><strong>{paper.data ? `${paper.data.data.length} / 3` : "—"}</strong><p>三张官方策略使用独立模拟本金</p></article>
        <article><span>可开仓组合</span><strong>{paper.data ? portfolioSummary.activePortfolioCount : "—"}</strong><p>账户状态允许新开仓</p></article>
        <article><span>运行中策略</span><strong>{paper.data ? portfolioSummary.runningStrategyCount : "—"}</strong><p>策略状态，不代表 Worker 健康</p></article>
      </div>
    </section>

    <section className={styles.strategySection} aria-labelledby="official-strategies-title">
      <header><div><span className={styles.eyebrow}>OFFICIAL SPOT STRATEGIES</span><h2 id="official-strategies-title">三张官方策略</h2></div><Link href="/trading-hall">查看决策与成交 →</Link></header>
      {!canViewPaper ? <p className={styles.empty}>当前账户没有查看模拟组合的权限。</p>
        : paper.error ? <p className={styles.empty}>组合读取失败，可在上方重试。</p>
          : paper.loading || !paper.data ? <div className={styles.strategySkeleton} aria-label="策略组合加载中" />
            : paper.data.data.length === 0 ? <p className={styles.empty}>当前尚未初始化官方模拟组合。会员激活后由服务端创建，不会生成占位收益。</p>
              : <div className={styles.strategyGrid}>{paper.data.data.map((portfolio) => <Link href={`/paper/${portfolio.id}`} className={styles.strategyCard} key={portfolio.id}>
                <header><div><span>{portfolio.strategyCode}</span><h3>{strategyLabels[portfolio.strategyCode]}</h3></div><i>{portfolioStatusLabels[portfolio.status]}</i></header>
                <dl><div><dt>组合权益</dt><dd>{portfolio.equityUsdt} USDT</dd></div><div><dt>已实现净收益</dt><dd className={pnlClass(portfolio.realizedNetPnlUsdt)}>{portfolio.realizedNetPnlUsdt}</dd></div><div><dt>持仓</dt><dd>{portfolio.openPositionCount}</dd></div></dl>
                <footer><span>{runtimeLabels[portfolio.runtime.state]}</span><span>{portfolio.runtime.lastDecisionAt ? `最近决策 ${formatDateTime(portfolio.runtime.lastDecisionAt)}` : "暂无决策"}</span></footer>
              </Link>)}</div>}
    </section>

    <section className={styles.nextStep} aria-labelledby="next-step-title" aria-live="polite" role={task.state === "ERROR" ? "alert" : undefined}>
      <div><span className={styles.eyebrow}>NEXT STEP</span><h2 id="next-step-title">{task.title}</h2><p>{task.description}</p></div>
      {task.href && task.action && <Link href={task.href}>{task.action}</Link>}
    </section>

    <section className={styles.statusGrid} aria-label="账户服务状态">
      {canViewMembership && (membership.error || orders.error
        ? <StatusCard label="会员状态" value="读取失败" detail={membership.error || orders.error} state="error" retry={() => { void membership.refresh(); void orders.refresh(); }} />
        : membership.loading || orders.loading
          ? <StatusCard label="会员状态" value="正在读取" detail="正在读取权益与最近申请" state="loading" />
          : <StatusCard label="会员状态" value={membership.data?.membership ? membershipLabels[membership.data.membership.status] ?? membership.data.membership.status : "尚未激活"} detail={membership.data?.membership ? `${membership.data.membership.planCode} · ${membership.data.membership.expiresAt ? `到期 ${formatDateTime(membership.data.membership.expiresAt)}` : "长期有效"}` : orders.data?.data[0] ? `最近申请：${orderLabels[orders.data.data[0].status] ?? orders.data.data[0].status}` : "当前没有申请记录"} />)}
      {canViewCredits && (credits.error
        ? <StatusCard label="AI 积分" value="读取失败" detail={credits.error} state="error" retry={credits.refresh} />
        : credits.loading || !credits.data
          ? <StatusCard label="AI 积分" value="正在读取" detail="积分与钱包余额分开记录" state="loading" />
          : <StatusCard label="AI 积分" value={credits.data.credits.available} detail={`预留 ${credits.data.credits.reserved} · 版本 ${credits.data.credits.version}`} />)}
      {notifications.error
        ? <StatusCard label="未读通知" value="读取失败" detail={notifications.error} state="error" retry={notifications.refresh} />
        : notifications.loading || !notifications.data
          ? <StatusCard label="未读通知" value="正在读取" detail="仅读取当前账户" state="loading" />
          : <StatusCard label="未读通知" value={String(notifications.data.unread)} detail={notifications.data.unread > 0 ? "前往通知中心查看" : "当前没有未读消息"} />}
      {canViewMembership && (statements.error
        ? <StatusCard label="最新绩效账单" value="读取失败" detail={statements.error} state="error" retry={statements.refresh} />
        : statements.loading || !statements.data
          ? <StatusCard label="最新绩效账单" value="正在读取" detail="按 UTC 周期读取" state="loading" />
          : statements.data.data[0]
            ? <StatusCard label="最新绩效账单" value={statementLabels[statements.data.data[0].status] ?? statements.data.data[0].status} detail={`${formatDecimal(statements.data.data[0].feeAmount)} USDT · ${formatDateTime(statements.data.data[0].cycleEndedAt)}`} />
            : <StatusCard label="最新绩效账单" value="暂无账单" detail="当前没有已生成账单" />)}
    </section>

    <section className={styles.moduleSection} aria-labelledby="client-tools-title">
      <header><div><span className={styles.eyebrow}>ACCOUNT TOOLS</span><h2 id="client-tools-title">常用工具</h2></div></header>
      <div className={styles.moduleGrid}>{visibleModules.map((module) => <Link href={module.href} key={module.href}>
        <span>{module.accent}</span><strong>{module.title}</strong><p>{module.description}</p><b aria-hidden="true">→</b>
      </Link>)}</div>
    </section>

    <aside className={styles.riskNote} role="note">所有组合、成交和收益均为 Paper 模拟数据，不代表真实或未来收益；平台 Demo 测试证据不会改变客户组合。</aside>
  </ClientPortalShell>;
}
