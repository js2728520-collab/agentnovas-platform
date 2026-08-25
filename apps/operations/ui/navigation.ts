import type { ConsoleNavigationGroup } from "@/packages/contracts/src/riverton-ui";

/**
 * 运营端导航。
 *
 * 外壳渲染在根 layout 里（跨导航保留），所以导航配置必须独立于页面模块，
 * 否则 layout 会把整个页面模块拖进公共包。
 */
export const navigation: ConsoleNavigationGroup[] = [
  { label: "概览", items: [
    { href: "/", label: "运营概览", icon: "dashboard" },
  ] },
  { label: "获客", items: [
    { href: "/invitations", label: "我的邀请链接", icon: "users", requiredPermissions: ["ops.invitations.view", "ops.invitations.manage"] },
  ] },
  { label: "客户与团队", items: [
    { href: "/customers", label: "客户管理", icon: "users", requiredPermissions: ["ops.customers.view"] },
    { href: "/accounts", label: "运营账号", icon: "users", requiredPermissions: ["ops.organization.view"] },
    { href: "/team", label: "团队目标", icon: "chart", requiredPermissions: ["ops.team.view"] },
    { href: "/data-center", label: "数据中心", icon: "database", requiredPermissions: ["ops.customers.view"] },
  ] },
  { label: "商业与资金", items: [
    { href: "/membership-orders", label: "会员订单", icon: "file", requiredPermissions: ["ops.membership_orders.view"] },
    { href: "/performance-statements", label: "周分成", icon: "percent", requiredPermissions: ["ops.performance_fees.view"] },
    { href: "/credits", label: "Credits", icon: "coins", requiredPermissions: ["ops.credits.view"] },
    { href: "/deposits", label: "充值订单", icon: "deposit", requiredPermissions: ["ops.deposits.view"] },
    { href: "/ledger", label: "账本查询", icon: "book", requiredPermissions: ["ops.ledger.view"] },
    { href: "/finance", label: "财务结算", icon: "calculator", requiredPermissions: ["ops.ledger.view", "ops.membership_orders.view", "ops.performance_fees.view"] },
  ] },
  { label: "风控", items: [
    { href: "/kill-switches", label: "交易熔断", icon: "shield", requiredPermissions: ["ops.trading.manage"] },
    { href: "/follow-risk", label: "跟单风控", icon: "shield", requiredPermissions: ["ops.follow_risk.view"] },
    { href: "/live-routing", label: "实盘路由", icon: "shield", requiredPermissions: ["ops.trading.manage"] },
  ] },
  { label: "治理", items: [
    { href: "/approvals", label: "审批中心", icon: "check-square", requiredPermissions: ["ops.approvals.view", "ops.approvals.decide", "ops.deposits.action_approve", "ops.roles.approve_sensitive", "ops.credits.approve", "ops.attributions.manage", "ops.membership_orders.approve", "ops.performance_fees.approve", "ops.performance_fees.payment_approve"] },
    { href: "/access", label: "角色权限", icon: "key", requiredPermissions: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"] },
    { href: "/access/audit", label: "授权审计", icon: "audit", requiredPermissions: ["ops.roles.manage", "ops.roles.approve_sensitive"] },
    { href: "/account/security", label: "账号安全", icon: "shield" },
  ] },
];
