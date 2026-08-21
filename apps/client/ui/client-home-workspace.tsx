"use client";

import Link from "next/link";

import type { AiCreditBalance, CursorPage, MembershipEntitlement, MembershipOrder, PaperPortfolio, PerformanceFeeStatement } from "@/packages/contracts/src/commercial-beta";
import { formatDateTime, formatDecimal, hasAnyPermission, type EffectiveAccessPayload, type ViewerPayload } from "@/packages/contracts/src/riverton-ui";
import { PageHeading, StatusBadge } from "@/packages/ui/src/page-state";
import { useApiData } from "@/packages/ui/src/use-api-data";

import { deriveClientHomeTask } from "./client-home-model";
import { ClientPortalShell } from "./client-portal-shell";
import styles from "./client-home-workspace.module.css";

const modules = [
  { href: "/membership", permission: "client.membership.view", title: "会员与披露", description: "核对计划、商业披露快照、人工付款申请和权益状态。" },
  { href: "/performance-statements", permission: "client.membership.view", title: "绩效账单", description: "查看 paper 模拟收益、高水位、亏损结转与人工付款复核证据链。" },
  { href: "/credits", permission: "client.credits.view", title: "AI 积分", description: "查看与 USDT 钱包分离的可用、预留、发放和消耗。" },
  { href: "/paper", permission: "client.paper.view", title: "三卡 Paper", description: "查看服务端模拟资金、现货持仓与已实现收益。" },
  { href: "/trading-hall", permission: "client.paper.view", title: "七智能体交易大厅", description: "核对七阶段决策证据与真实订单关闭边界。" },
  { href: "/wallet", permission: "client.wallet.view", title: "只读钱包", description: "查看平台服务余额和不可变账本；Beta 不开放充值。" },
] as const;

const membershipLabels: Record<string, string> = {
  TRIAL: "试用中", ACTIVE: "生效中", GRACE: "宽限期", READ_ONLY: "只读", EXPIRED: "已到期", CANCELLED: "已取消",
};
const orderLabels: Record<string, string> = {
  AWAITING_EVIDENCE: "等待凭证", SUBMITTED: "人工复核中", REJECTED: "审核未通过", ACTIVATED: "已激活", CANCELLED: "已取消",
};
const statementLabels: Record<string, string> = {
  SUBMITTED: "等待业务审批", APPROVED: "业务审批已记录", REJECTED: "审核未通过", INVOICED: "等待付款复核", PAID: "付款已复核", CLOSED_NO_FEE: "无需支付",
};

function SummaryCard({ label, value, detail, state, retry }: { label: string; value: string; detail: string; state?: "loading" | "error"; retry?: () => void }) {
  return <article className={styles.summaryCard} aria-busy={state === "loading" || undefined} role={state === "error" ? "alert" : undefined}>
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
  const visible = modules.filter((module) => hasAnyPermission(access.permissions, [module.permission]));
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

  return <ClientPortalShell viewer={viewer} access={access}>
    <PageHeading
      eyebrow="RIVERTON CAPITAL · CONTROLLED BETA"
      title="客户工作台"
      description="从服务端状态开始下一步；模块读取彼此独立，单项失败不会被包装成成功。"
      actions={<StatusBadge value="INVITE ONLY" />}
    />

    <section className={styles.task} aria-labelledby="next-task-title" aria-live="polite" role={task.state === "ERROR" ? "alert" : undefined}>
      <div>
        <span className={styles.eyebrow}>NEXT VERIFIED STEP · {task.state}</span>
        <h2 id="next-task-title">{task.title}</h2>
        <p>{task.description}</p>
      </div>
      {task.href && task.action && <Link className={styles.taskLink} href={task.href}>{task.action}</Link>}
    </section>

    <section className={styles.summary} aria-label="客户实时状态摘要">
      {canViewMembership && (membership.error || orders.error
          ? <SummaryCard label="会员与申请" value="读取失败" detail={membership.error || orders.error} state="error" retry={() => { void membership.refresh(); void orders.refresh(); }} />
          : membership.loading || orders.loading
            ? <SummaryCard label="会员与申请" value="正在核对" detail="分别读取权益与最近申请" state="loading" />
            : <SummaryCard label="会员与申请" value={membership.data?.membership ? membershipLabels[membership.data.membership.status] ?? membership.data.membership.status : "尚未激活"} detail={membership.data?.membership ? `${membership.data.membership.planCode} · ${membership.data.membership.expiresAt ? `到期 ${formatDateTime(membership.data.membership.expiresAt)}` : "长期有效"}` : orders.data?.data[0] ? `最近申请：${orderLabels[orders.data.data[0].status] ?? orders.data.data[0].status}` : "当前没有申请记录"} />)}
      {canViewCredits && (credits.error
          ? <SummaryCard label="AI 积分" value="读取失败" detail={credits.error} state="error" retry={credits.refresh} />
          : credits.loading || !credits.data
            ? <SummaryCard label="AI 积分" value="正在核对" detail="积分与钱包余额完全分离" state="loading" />
            : <SummaryCard label="AI 积分" value={credits.data.credits.available} detail={`预留 ${credits.data.credits.reserved} · 账本版本 ${credits.data.credits.version}`} />)}
      {canViewPaper && (paper.error
          ? <SummaryCard label="官方模拟组合" value="读取失败" detail={paper.error} state="error" retry={paper.refresh} />
          : paper.loading || !paper.data
            ? <SummaryCard label="官方模拟组合" value="正在核对" detail="以服务端返回为准" state="loading" />
            : <SummaryCard label="官方模拟组合" value={`${paper.data.data.length} / 3`} detail={`${paper.data.data.filter((item) => item.status === "ACTIVE").length} 张允许新开仓 · 不代表 Worker 正在运行`} />)}
      {canViewMembership && (statements.error
          ? <SummaryCard label="最新绩效账单" value="读取失败" detail={statements.error} state="error" retry={statements.refresh} />
          : statements.loading || !statements.data
            ? <SummaryCard label="最新绩效账单" value="正在核对" detail="按 UTC 周期读取 paper 账单" state="loading" />
            : statements.data.data[0]
              ? <SummaryCard label="最新绩效账单" value={statementLabels[statements.data.data[0].status] ?? statements.data.data[0].status} detail={`应收 ${formatDecimal(statements.data.data[0].feeAmount)} USDT · ${formatDateTime(statements.data.data[0].cycleEndedAt)}`} />
              : <SummaryCard label="最新绩效账单" value="暂无账单" detail="没有可结算周期时不会生成模拟数据" />)}
      {notifications.error
          ? <SummaryCard label="未读通知" value="读取失败" detail={notifications.error} state="error" retry={notifications.refresh} />
          : notifications.loading || !notifications.data
            ? <SummaryCard label="未读通知" value="正在核对" detail="仅读取当前账户站内未读数量" state="loading" />
            : <SummaryCard label="未读通知" value={String(notifications.data.unread)} detail={notifications.data.unread > 0 ? "前往通知中心逐项核对" : "当前没有未读站内通知"} />}
    </section>

    <aside className={styles.boundary} role="note">
      <strong>Beta 执行边界</strong>
      <p>客户不上传交易所密钥；客户 paper 与平台 Demo 回执分离；真实交易、自动支付和客户充值保持关闭。这里是产品边界说明，不是收益或运行 KPI。</p>
    </aside>

    <section className={styles.modules} aria-labelledby="client-modules-title">
      <header><div><span className={styles.eyebrow}>PERMISSION-AWARE MODULES</span><h2 id="client-modules-title">已授权模块</h2></div><StatusBadge value={`${visible.length} 项`} /></header>
      <div className={styles.moduleList}>{visible.map((module, index) => <Link href={module.href} key={module.href}>
        <span className={styles.moduleIndex}>{String(index + 1).padStart(2, "0")}</span>
        <span><strong>{module.title}</strong><small>{module.description}</small></span>
        <b aria-hidden="true">→</b>
      </Link>)}</div>
    </section>
  </ClientPortalShell>;
}
