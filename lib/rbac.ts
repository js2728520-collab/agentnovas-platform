import type { AppAudience } from "./riverton-apps.ts";

export const DATA_SCOPES = ["SELF", "DIRECT_REPORTS", "TEAM_TREE", "ORGANIZATION", "ORGANIZATION_SET", "PLATFORM"] as const;
export type DataScope = typeof DATA_SCOPES[number];

export type PermissionDefinition = {
  key: string;
  appId: AppAudience;
  label: string;
  sensitive?: boolean;
};

export type RolePermission = {
  permissionKey: string;
  scope: DataScope;
};

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { key: "client.strategies.create", appId: "client", label: "创建策略" },
  { key: "client.strategies.publish", appId: "client", label: "提交策略广场" },
  { key: "client.wallet.view", appId: "client", label: "查看钱包" },
  { key: "client.deposit.create", appId: "client", label: "创建充值订单" },
  { key: "client.membership.view", appId: "client", label: "查看会员权益" },
  { key: "client.membership.order", appId: "client", label: "提交会员订单", sensitive: true },
  { key: "client.credits.view", appId: "client", label: "查看积分余额" },
  { key: "client.paper.view", appId: "client", label: "查看模拟交易" },
  { key: "client.paper.manage", appId: "client", label: "启动与停止模拟策略", sensitive: true },
  { key: "ops.customers.view", appId: "operations", label: "查看客户" },
  { key: "ops.customers.manage", appId: "operations", label: "管理客户", sensitive: true },
  { key: "ops.customers.pii_contact", appId: "operations", label: "查看客户完整联系方式", sensitive: true },
  { key: "ops.customers.pii_security", appId: "operations", label: "查看客户登录与设备信息", sensitive: true },
  { key: "ops.customers.pii_financial", appId: "operations", label: "查看客户累计充值与消费", sensitive: true },
  { key: "ops.customers.pii_trading", appId: "operations", label: "查看客户交易所账户与持仓", sensitive: true },
  { key: "ops.customers.export", appId: "operations", label: "导出客户数据", sensitive: true },
  { key: "ops.deposits.view", appId: "operations", label: "查看充值订单" },
  { key: "ops.deposits.export", appId: "operations", label: "导出充值订单", sensitive: true },
  { key: "ops.deposits.pii_reveal", appId: "operations", label: "查看完整敏感字段", sensitive: true },
  { key: "ops.deposits.action_request", appId: "operations", label: "发起充值人工操作", sensitive: true },
  { key: "ops.deposits.action_approve", appId: "operations", label: "审批充值人工操作", sensitive: true },
  { key: "ops.ledger.view", appId: "operations", label: "查看账务" },
  { key: "ops.reconciliation.run", appId: "operations", label: "执行对账", sensitive: true },
  { key: "ops.membership_orders.view", appId: "operations", label: "查看会员订单" },
  { key: "ops.membership_orders.evidence", appId: "operations", label: "录入会员付款凭证", sensitive: true },
  { key: "ops.membership_orders.approve", appId: "operations", label: "审批会员订单", sensitive: true },
  { key: "ops.credits.view", appId: "operations", label: "查看客户积分" },
  { key: "ops.credits.adjust", appId: "operations", label: "发起积分调整", sensitive: true },
  { key: "ops.credits.approve", appId: "operations", label: "审批积分调整", sensitive: true },
  // 交易熔断与实盘路由授权。标 sensitive 因此强制近期 MFA——它既能停掉全平台的
  // 新开仓，也能批准真实下单。
  { key: "ops.trading.manage", appId: "operations", label: "管理交易熔断与实盘路由", sensitive: true },
  { key: "ops.performance_fees.view", appId: "operations", label: "查看绩效费账单" },
  { key: "ops.performance_fees.generate", appId: "operations", label: "生成绩效费账单", sensitive: true },
  { key: "ops.performance_fees.approve", appId: "operations", label: "审批绩效费账单", sensitive: true },
  { key: "ops.performance_fees.payment_evidence", appId: "operations", label: "录入绩效费付款凭证", sensitive: true },
  { key: "ops.performance_fees.payment_approve", appId: "operations", label: "审批绩效费付款", sensitive: true },
  { key: "ops.support.manage", appId: "operations", label: "处理客服工单" },
  { key: "ops.approvals.view", appId: "operations", label: "查看审批中心" },
  { key: "ops.approvals.decide", appId: "operations", label: "处理审批", sensitive: true },
  { key: "ops.attributions.manage", appId: "operations", label: "管理客户归属", sensitive: true },
  { key: "ops.finance.manage", appId: "operations", label: "执行财务操作", sensitive: true },
  { key: "ops.invitations.view", appId: "operations", label: "查看邀请码" },
  { key: "ops.invitations.manage", appId: "operations", label: "创建邀请码", sensitive: true },
  { key: "ops.organization.view", appId: "operations", label: "查看组织成员" },
  { key: "ops.organization.manage", appId: "operations", label: "管理组织成员", sensitive: true },
  { key: "ops.team.view", appId: "operations", label: "查看团队运营数据" },
  { key: "ops.team.manage", appId: "operations", label: "管理团队运营数据", sensitive: true },
  { key: "ops.roles.manage", appId: "operations", label: "管理运营角色", sensitive: true },
  { key: "ops.roles.assign", appId: "operations", label: "分配运营角色", sensitive: true },
  { key: "ops.roles.approve_sensitive", appId: "operations", label: "审批敏感权限", sensitive: true },
  { key: "maint.llm_profiles.manage", appId: "maintenance", label: "管理模型 Profile", sensitive: true },
  { key: "maint.agent_bindings.manage", appId: "maintenance", label: "管理 Agent 绑定", sensitive: true },
  { key: "maint.payment_integrations.manage", appId: "maintenance", label: "管理支付集成", sensitive: true },
  { key: "maint.email_integrations.manage", appId: "maintenance", label: "管理邮件集成", sensitive: true },
  { key: "maint.feature_flags.manage", appId: "maintenance", label: "管理功能开关", sensitive: true },
  { key: "maint.system_health.view", appId: "maintenance", label: "查看系统健康" },
  { key: "maint.ai_usage.view", appId: "maintenance", label: "查看 AI 用量与可靠性", sensitive: true },
  { key: "maint.emergency_pause.execute", appId: "maintenance", label: "执行紧急暂停", sensitive: true },
  { key: "maint.audit.view", appId: "maintenance", label: "查看审计" },
  { key: "maint.roles.manage", appId: "maintenance", label: "管理运维角色", sensitive: true },
  { key: "maint.roles.approve_sensitive", appId: "maintenance", label: "审批运维敏感权限", sensitive: true },
  { key: "maint.follow_policy.view", appId: "maintenance", label: "查看跟随策略规则" },
  { key: "maint.follow_policy.manage", appId: "maintenance", label: "管理跟随策略规则", sensitive: true },
  { key: "maint.demo_exchanges.view", appId: "maintenance", label: "查看模拟交易所" },
  { key: "maint.demo_exchanges.manage", appId: "maintenance", label: "管理模拟交易所", sensitive: true },
  { key: "maint.demo_exchanges.verify", appId: "maintenance", label: "验证模拟交易所", sensitive: true },
  { key: "maint.demo_exchanges.kill", appId: "maintenance", label: "紧急停止模拟交易所", sensitive: true },
  { key: "maint.commercial_disclosures.view", appId: "maintenance", label: "查看商业披露" },
  { key: "maint.commercial_disclosures.submit", appId: "maintenance", label: "提交商业披露发布", sensitive: true },
  { key: "maint.commercial_disclosures.approve", appId: "maintenance", label: "审批商业披露发布", sensitive: true },
  { key: "maint.releases.view", appId: "maintenance", label: "查看发布版本" },
  { key: "maint.releases.manage", appId: "maintenance", label: "登记发布版本", sensitive: true },
  { key: "maint.releases.approve", appId: "maintenance", label: "复核发布与回滚证据", sensitive: true },
  { key: "maint.configuration_versions.view", appId: "maintenance", label: "查看版本化配置" },
  { key: "maint.configuration_versions.manage", appId: "maintenance", label: "管理配置草稿与测试", sensitive: true },
  { key: "maint.configuration_versions.approve", appId: "maintenance", label: "审批与调度配置", sensitive: true },
  { key: "maint.configuration_versions.activate", appId: "maintenance", label: "激活与回滚配置", sensitive: true },
];

export const SENSITIVE_PERMISSION_KEYS = new Set(
  PERMISSION_DEFINITIONS.filter((permission) => permission.sensitive).map((permission) => permission.key),
);

const scopeRank: Record<DataScope, number> = {
  SELF: 0,
  DIRECT_REPORTS: 1,
  TEAM_TREE: 2,
  ORGANIZATION: 3,
  ORGANIZATION_SET: 4,
  PLATFORM: 5,
};

export function effectivePermissionMap(permissions: RolePermission[]) {
  const entries = new Map<string, DataScope>();
  for (const permission of permissions) {
    const current = entries.get(permission.permissionKey);
    if (!current || scopeRank[permission.scope] > scopeRank[current]) {
      entries.set(permission.permissionKey, permission.scope);
    }
  }
  return Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right))) as Record<string, DataScope>;
}

export function validateDerivedRolePermissions(template: RolePermission[], derived: RolePermission[]) {
  const templateMap = new Map(template.map((permission) => [permission.permissionKey, permission.scope]));
  for (const permission of derived) {
    const maximumScope = templateMap.get(permission.permissionKey);
    if (!maximumScope) {
      return { ok: false as const, code: "PERMISSION_NOT_IN_TEMPLATE", permissionKey: permission.permissionKey };
    }
    if (scopeRank[permission.scope] > scopeRank[maximumScope]) {
      return { ok: false as const, code: "SCOPE_ESCALATION", permissionKey: permission.permissionKey };
    }
  }
  return { ok: true as const };
}

export function canApproveAccessChange(input: {
  requesterUserId: string;
  approverUserId: string;
  approverPermissionKeys: string[];
  requestedPermissionKeys: string[];
}) {
  if (input.requesterUserId === input.approverUserId) {
    return { ok: false as const, code: "SELF_APPROVAL_FORBIDDEN" };
  }
  const hasSensitive = input.requestedPermissionKeys.some((key) => SENSITIVE_PERMISSION_KEYS.has(key));
  if (!hasSensitive) return { ok: true as const };
  const canApprove = input.approverPermissionKeys.includes("ops.roles.approve_sensitive")
    || input.approverPermissionKeys.includes("maint.roles.approve_sensitive");
  if (!canApprove) return { ok: false as const, code: "APPROVER_LACKS_SENSITIVE_APPROVAL" };
  return { ok: true as const };
}

type LegacyAssignment = {
  appId: AppAudience;
  roleCode: string;
  permissions: RolePermission[];
};

export function legacyRoleAssignments(role: string): LegacyAssignment[] {
  switch (role) {
    case "hq_admin":
      return [
        { appId: "client", roleCode: "client_strategy_author", permissions: clientCustomerPermissions() },
        { appId: "operations", roleCode: "ops_hq_general_manager", permissions: operationsPlatformPermissions() },
        { appId: "maintenance", roleCode: "maint_break_glass_admin", permissions: maintenancePlatformPermissions() },
      ];
    case "tech_staff":
      // 运维端技术人员。
      //
      // 此前运维端只有 hq_admin 能进，于是「只该管模型配置和发布」的人必须当
      // hq_admin，而那会同时给他运营端全部权限——改客户归属、看客户 PII。
      // 这个角色把技术操作和业务/治理权限分开。
      //
      // 刻意不给的四类，每一类都有具体理由：
      //   - roles.manage / roles.approve_sensitive：权限管理是治理，不是技术操作。
      //     能给自己加权限的技术账号等于没有权限体系。
      //   - releases.approve：登记发布的人不能自己复核（maker/checker）。
      //     技术人员登记版本，由另一个人验证证据后放行。
      //   - emergency_pause.execute / demo_exchanges.kill：熔断是业务决定，
      //     停下来影响的是客户能不能交易，不该由值班工程师单独按。
      //   - payment_integrations.manage / commercial_disclosures.*：碰钱与对外承诺。
      return [{ appId: "maintenance", roleCode: "maint_technical", permissions: [
        { permissionKey: "maint.llm_profiles.manage", scope: "PLATFORM" },
        { permissionKey: "maint.agent_bindings.manage", scope: "PLATFORM" },
        { permissionKey: "maint.email_integrations.manage", scope: "PLATFORM" },
        { permissionKey: "maint.feature_flags.manage", scope: "PLATFORM" },
        { permissionKey: "maint.system_health.view", scope: "PLATFORM" },
        { permissionKey: "maint.ai_usage.view", scope: "PLATFORM" },
        { permissionKey: "maint.audit.view", scope: "PLATFORM" },
        { permissionKey: "maint.demo_exchanges.view", scope: "PLATFORM" },
        { permissionKey: "maint.demo_exchanges.verify", scope: "PLATFORM" },
        { permissionKey: "maint.follow_policy.view", scope: "PLATFORM" },
        { permissionKey: "maint.releases.view", scope: "PLATFORM" },
        { permissionKey: "maint.releases.manage", scope: "PLATFORM" },
        { permissionKey: "maint.configuration_versions.view", scope: "PLATFORM" },
        { permissionKey: "maint.configuration_versions.manage", scope: "PLATFORM" },
      ] }];
    case "hq_support":
      return [{ appId: "operations", roleCode: "ops_hq_support", permissions: [
        { permissionKey: "ops.customers.view", scope: "PLATFORM" },
        { permissionKey: "ops.support.manage", scope: "PLATFORM" },
        { permissionKey: "ops.deposits.view", scope: "PLATFORM" },
      ] }];
    case "branch_admin":
      return [{ appId: "operations", roleCode: "ops_branch_admin", permissions: [
        { permissionKey: "ops.customers.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.customers.manage", scope: "ORGANIZATION" },
        { permissionKey: "ops.deposits.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.ledger.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.approvals.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.approvals.decide", scope: "ORGANIZATION" },
        { permissionKey: "ops.attributions.manage", scope: "ORGANIZATION" },
        { permissionKey: "ops.finance.manage", scope: "ORGANIZATION" },
        { permissionKey: "ops.invitations.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.invitations.manage", scope: "ORGANIZATION" },
        { permissionKey: "ops.organization.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.organization.manage", scope: "ORGANIZATION" },
        { permissionKey: "ops.team.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.team.manage", scope: "ORGANIZATION" },
      ] }];
    case "finance":
      return [{ appId: "operations", roleCode: "ops_finance", permissions: [
        { permissionKey: "ops.customers.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.ledger.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.finance.manage", scope: "ORGANIZATION" },
        { permissionKey: "ops.approvals.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.approvals.decide", scope: "ORGANIZATION" },
      ] }];
    case "auditor":
      return [{ appId: "operations", roleCode: "ops_auditor", permissions: [
        { permissionKey: "ops.customers.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.ledger.view", scope: "ORGANIZATION" },
        { permissionKey: "ops.approvals.view", scope: "ORGANIZATION" },
      ] }];
    case "manager":
      return [{ appId: "operations", roleCode: "ops_manager", permissions: [
        { permissionKey: "ops.customers.view", scope: "TEAM_TREE" },
        { permissionKey: "ops.customers.manage", scope: "TEAM_TREE" },
        { permissionKey: "ops.deposits.view", scope: "TEAM_TREE" },
        { permissionKey: "ops.attributions.manage", scope: "TEAM_TREE" },
        { permissionKey: "ops.invitations.view", scope: "TEAM_TREE" },
        { permissionKey: "ops.invitations.manage", scope: "TEAM_TREE" },
        { permissionKey: "ops.organization.view", scope: "TEAM_TREE" },
        { permissionKey: "ops.organization.manage", scope: "TEAM_TREE" },
        { permissionKey: "ops.team.view", scope: "TEAM_TREE" },
        { permissionKey: "ops.team.manage", scope: "TEAM_TREE" },
      ] }];
    case "supervisor":
    case "employee":
      return [{ appId: "operations", roleCode: `ops_${role}`, permissions: [
        { permissionKey: "ops.customers.view", scope: "DIRECT_REPORTS" },
        { permissionKey: "ops.customers.manage", scope: "DIRECT_REPORTS" },
        { permissionKey: "ops.organization.view", scope: "DIRECT_REPORTS" },
        { permissionKey: "ops.team.view", scope: "DIRECT_REPORTS" },
        ...(role === "supervisor" ? [
          { permissionKey: "ops.organization.manage", scope: "DIRECT_REPORTS" as const },
          { permissionKey: "ops.invitations.view", scope: "DIRECT_REPORTS" as const },
          { permissionKey: "ops.invitations.manage", scope: "DIRECT_REPORTS" as const },
          { permissionKey: "ops.team.manage", scope: "DIRECT_REPORTS" as const },
        ] : []),
      ] }];
    case "customer":
      return [{ appId: "client", roleCode: "client_customer", permissions: clientCustomerPermissions() }];
    default:
      return [];
  }
}

export function legacyPermissionsForApp(role: string, appId: AppAudience) {
  return legacyRoleAssignments(role).filter((assignment) => assignment.appId === appId).flatMap((assignment) => assignment.permissions);
}

function clientCustomerPermissions(): RolePermission[] {
  return [
    { permissionKey: "client.strategies.create", scope: "SELF" },
    { permissionKey: "client.strategies.publish", scope: "SELF" },
    { permissionKey: "client.wallet.view", scope: "SELF" },
    { permissionKey: "client.deposit.create", scope: "SELF" },
    { permissionKey: "client.membership.view", scope: "SELF" },
    { permissionKey: "client.membership.order", scope: "SELF" },
    { permissionKey: "client.credits.view", scope: "SELF" },
    { permissionKey: "client.paper.view", scope: "SELF" },
    { permissionKey: "client.paper.manage", scope: "SELF" },
  ];
}

function operationsPlatformPermissions(): RolePermission[] {
  return PERMISSION_DEFINITIONS
    .filter((permission) => permission.appId === "operations")
    .map((permission) => ({ permissionKey: permission.key, scope: "PLATFORM" as const }));
}

function maintenancePlatformPermissions(): RolePermission[] {
  return PERMISSION_DEFINITIONS
    .filter((permission) => permission.appId === "maintenance")
    .map((permission) => ({ permissionKey: permission.key, scope: "PLATFORM" as const }));
}
