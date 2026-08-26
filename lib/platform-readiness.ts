/**
 * 开服就绪清单。
 *
 * 首次上线要配的东西散在至少六处：数据库角色、初始管理员、组织树、七项披露、
 * 会员计划、模型绑定、支付与邮件集成。此前「还差什么」这个问题**没有答案**——
 * 只能靠人翻手册逐条对。
 *
 * 刻意做成**只读检查**而不是自动化脚本：这些配置项里有一半是不该自动化的——
 * 七项披露要双人审批、优盾凭证要人工填、初始管理员密码不能由脚本生成。
 * 自动化它们等于绕过刚建好的治理控制。
 *
 * 它也不只服务于开服：上线后这份清单变成持续的健康检查。某天有人把披露下架了，
 * 或者某个 Agent 角色的模型被停用，清单会立刻变红。
 */

import type { Pool } from "pg";

import { agentRoles, runtimeExplanationRoles } from "./agent-model-profiles.ts";

export type ReadinessSeverity = "blocking" | "warning" | "info";

export type ReadinessCheck = {
  key: string;
  label: string;
  /** ready 表示这一项不需要再做；其余状态都附带「该做什么」。 */
  status: "ready" | "missing" | "partial";
  severity: ReadinessSeverity;
  detail: string;
  /** 具体动作。写成运维能照着做的一句话，而不是「请配置 X」。 */
  action: string | null;
};

async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const row = (await pool.query<{ n: string }>(sql, params)).rows[0];
  return Number(row?.n ?? 0);
}

/**
 * 数据库角色。缺角色时发布闸门 postgres-role-policy 会直接失败，
 * 所以这一项红了就不用往下看了。
 */
async function checkDatabaseRoles(pool: Pool): Promise<ReadinessCheck> {
  const expected = [
    "agentnovas_migrator", "agentnovas_client_auth", "agentnovas_client_web",
    "agentnovas_ops_web", "agentnovas_maint_web", "agentnovas_execution_service",
    "agentnovas_payment_webhook", "agentnovas_notification_worker",
    "agentnovas_demo_execution_worker", "agentnovas_runtime_worker",
  ];
  const rows = await pool.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [expected],
  );
  const present = new Set(rows.rows.map((row) => row.rolname));
  const missing = expected.filter((role) => !present.has(role));
  return {
    key: "database_roles",
    label: "数据库角色",
    status: missing.length === 0 ? "ready" : "missing",
    severity: "blocking",
    detail: missing.length === 0
      ? `${expected.length} 个角色齐全`
      : `缺少 ${missing.join("、")}`,
    action: missing.length === 0 ? null
      : "执行 deploy/postgres/least-privilege-roles.sql，然后跑 postgres-role-policy 校验",
  };
}

/** 内部管理员。没有它就没人能登录运营端与运维端做后续配置。 */
async function checkAdministrator(pool: Pool): Promise<ReadinessCheck> {
  const total = await count(pool,
    "SELECT count(*)::text AS n FROM users WHERE role='hq_admin' AND status='active'");
  return {
    key: "administrator",
    label: "初始管理员",
    status: total > 0 ? "ready" : "missing",
    severity: "blocking",
    detail: total > 0 ? `${total} 个生效中的总公司管理员` : "尚未创建",
    action: total > 0 ? null
      : "设置 ALLOW_INTERNAL_BOOTSTRAP=1 后执行 scripts/bootstrap-internal-admin.mjs",
  };
}

/**
 * 七项商业披露。
 *
 * 它同时是**下单闸门**：未配齐时 createMembershipOrder 会拒绝，客户连会员都买不了。
 * 而且它必须走双人审批，不能靠脚本补。
 */
async function checkLegalDisclosures(pool: Pool): Promise<ReadinessCheck> {
  const published = await count(pool,
    "SELECT count(DISTINCT document_type)::text AS n FROM commercial_legal_document_versions WHERE status='published'");
  return {
    key: "legal_disclosures",
    label: "七项商业披露",
    status: published >= 7 ? "ready" : published > 0 ? "partial" : "missing",
    severity: "blocking",
    detail: `已发布 ${published}/7`,
    action: published >= 7 ? null
      : "运维端「设置 → 商业披露」逐项提交，再由另一人审批；未配齐时客户无法下单，公开条款页也是空的",
  };
}

/** 会员计划。迁移里有种子，正常情况下不会缺。 */
async function checkMembershipPlans(pool: Pool): Promise<ReadinessCheck> {
  const rows = await pool.query<{ n: string; currencies: string }>(
    `SELECT count(*)::text AS n, coalesce(string_agg(DISTINCT price_currency, ','), '') AS currencies
       FROM commercial_plan_versions WHERE status='active'`);
  const total = Number(rows.rows[0]?.n ?? 0);
  const currencies = rows.rows[0]?.currencies ?? "";
  // 币种必须与充值一致，否则客户充进来的钱付不了会员（见 migration 0059）。
  const currencyOk = currencies === "USDT";
  return {
    key: "membership_plans",
    label: "会员计划",
    status: total > 0 && currencyOk ? "ready" : "missing",
    severity: "blocking",
    detail: total === 0 ? "没有生效中的计划"
      : currencyOk ? `${total} 张，USDT 计价`
      : `${total} 张，但币种为 ${currencies}——与充值的 USDT 不一致，客户的余额将无法支付`,
    action: total > 0 && currencyOk ? null : "检查 commercial_plan_versions，确认迁移 0059 已应用",
  };
}

/**
 * 模型绑定。7 个研发 Agent 角色 + 3 个运行时解释角色。
 *
 * 未绑定的角色在运行时会静默跳过或降级——决策链仍然产出，但缺少那一段的分析。
 * 这不会报错，所以只有清单能发现。
 */
async function checkModelBindings(pool: Pool): Promise<ReadinessCheck> {
  const expected = agentRoles.length + runtimeExplanationRoles.length;
  const bound = await count(pool, `
    SELECT (
      (SELECT count(*) FROM agent_role_bindings WHERE enabled = true)
      + (SELECT count(*) FROM runtime_explanation_bindings WHERE enabled = true)
    )::text AS n`);
  return {
    key: "model_bindings",
    label: "Agent 模型绑定",
    status: bound >= expected ? "ready" : bound > 0 ? "partial" : "missing",
    severity: "blocking",
    detail: `已绑定 ${bound}/${expected}（${agentRoles.length} 个研发 Agent + ${runtimeExplanationRoles.length} 个运行时解释）`,
    action: bound >= expected ? null
      : "运维端「模型」页：先建 Profile 并测试连通，再为每个角色绑定；未绑定的角色会静默缺少那一段分析",
  };
}

/** 组织树。只有总公司时业绩归因链只有一级，分公司维度的统计是空的。 */
async function checkOrganizations(pool: Pool): Promise<ReadinessCheck> {
  const branches = await count(pool,
    "SELECT count(*)::text AS n FROM organizations WHERE type='branch' AND status='active'");
  return {
    key: "organizations",
    label: "组织架构",
    status: branches > 0 ? "ready" : "partial",
    severity: "warning",
    detail: branches > 0 ? `${branches} 个分公司` : "只有总公司，尚无分公司",
    action: branches > 0 ? null
      : "创建第一个 branch_admin 时会自动建立分公司；只有总公司时分公司维度的业绩统计是空的",
  };
}

/**
 * 充值通道。
 *
 * 特别提示 nginx 耦合：provider 切 active 之后客户就能拿到真实链上地址并打款，
 * 而回调仍撞在边缘的 404 上——钱到账，账本上什么都没有。
 */
async function checkDepositProvider(pool: Pool): Promise<ReadinessCheck> {
  const active = await count(pool,
    "SELECT count(*)::text AS n FROM payment_provider_configs WHERE status='active'");
  return {
    key: "deposit_provider",
    label: "充值通道",
    status: active > 0 ? "ready" : "missing",
    severity: "warning",
    detail: active > 0 ? `${active} 个已启用` : "未启用（客户无法充值）",
    action: active > 0 ? null
      : "填入优盾凭证后启用；**必须在同一次变更里打开 nginx 的回调 location**，否则客户打款后回调撞 404，钱到账而账本无记录",
  };
}

export async function collectPlatformReadiness(pool: Pool): Promise<{
  checks: ReadinessCheck[];
  blockingCount: number;
  readyCount: number;
}> {
  const checks = await Promise.all([
    checkDatabaseRoles(pool),
    checkAdministrator(pool),
    checkLegalDisclosures(pool),
    checkMembershipPlans(pool),
    checkModelBindings(pool),
    checkOrganizations(pool),
    checkDepositProvider(pool),
  ]);
  return {
    checks,
    blockingCount: checks.filter((check) => check.severity === "blocking" && check.status !== "ready").length,
    readyCount: checks.filter((check) => check.status === "ready").length,
  };
}
