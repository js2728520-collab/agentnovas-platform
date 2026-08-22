import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, memberships } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { PLATFORM_AI_STRATEGIES, isPlatformStrategyCode } from "@/lib/platform-ai-strategies";
import { getPostgresPool } from "@/lib/postgres";
import {
  createStrategyDeployment,
  endConflictingOfficialStrategyDeployments,
  OfficialStrategyModeSwitchOpenPositionError,
  StrategyDeploymentIdempotencyConflictError,
} from "@/lib/strategy-runtime-repository";
import { membershipAccess } from "@/lib/membership-rules";
import { ensureOfficialPaperPortfolios } from "@/lib/official-paper-repository";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { isCustomerTradingEmergencyStopped } from "@/lib/trading-emergency";

function normalizeSymbol(value: unknown) {
  return String(value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "client.paper.manage");
    if (await isCustomerTradingEmergencyStopped(user.id)) {
      throw new ResearchApiError("TRADING_EMERGENCY_STOPPED", "当前所属范围处于紧急暂停状态，暂不能启动平台策略", 503);
    }
    const { code } = await params;
    if (!isPlatformStrategyCode(code)) throw new ResearchApiError("PLATFORM_STRATEGY_NOT_FOUND", "平台策略不存在", 404);
    const definition = PLATFORM_AI_STRATEGIES[code];
    const body = await readResearchJson(request);
    if (body.riskConsent !== true) {
      throw new ResearchApiError("RISK_ACKNOWLEDGEMENT_REQUIRED", "请先确认历史表现不代表未来收益", 422, { fields: ["riskConsent"] });
    }
    const symbol = normalizeSymbol(body.symbol);
    const mode = String(body.mode ?? "paper");
    if (!(definition.symbols as readonly string[]).includes(symbol)) {
      throw new ResearchApiError("VALIDATION_ERROR", "请选择该平台策略支持的 USDT 现货交易对", 422, { fields: ["symbol"] });
    }
    if (mode !== "shadow" && mode !== "paper") {
      throw new ResearchApiError("VALIDATION_ERROR", "运行模式仅支持 shadow 或 paper", 422, { fields: ["mode"] });
    }

    const db = getDb();
    const membership = await db.select().from(memberships).where(and(
      eq(memberships.customerId, user.id),
      inArray(memberships.status, ["active", "grace"]),
    )).limit(1).then(rows => rows[0]);
    if (!membership) throw new ResearchApiError("MEMBERSHIP_REQUIRED", "会员权限不可用", 403);
    const access = membershipAccess(new Date().toISOString(), membership);
    if (!access.newEntriesAllowed) throw new ResearchApiError("MEMBERSHIP_ENTRY_BLOCKED", "会员当前不能新增策略", 403);

    const pool = await getPostgresPool();
    const mapped = (await pool.query<{
      strategy_id: string; strategy_version_id: string;
    }>(`
      SELECT strategy_id, strategy_version_id
      FROM platform_strategy_migration_map
      WHERE strategy_code = $1 AND symbol = $2
    `, [code, symbol])).rows[0];
    if (!mapped) {
      throw new ResearchApiError("PLATFORM_CUTOVER_NOT_READY", "平台策略尚未完成 V3 迁移，当前不能启动", 503);
    }
    const client = await pool.connect();
    let subscriptionId = "";
    let deployment: Awaited<ReturnType<typeof createStrategyDeployment>>;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`platform-follow:${user.id}`]);
      const portfolios = await ensureOfficialPaperPortfolios(client, {
        membershipId: membership.id,
        customerId: user.id,
      });
      const portfolio = portfolios.find(item => item.strategyCode === code);
      if (!portfolio) throw new Error("官方策略卡模拟组合初始化失败");
      const switched = await endConflictingOfficialStrategyDeployments(client, {
        ownerUserId: user.id,
        strategyCode: code,
        strategyId: mapped.strategy_id,
        strategyVersionId: mapped.strategy_version_id,
        mode,
        paperPortfolioId: portfolio.id,
      });
      if (switched.endedSubscriptionIds.length) {
        await client.query(`
          UPDATE strategy_subscriptions
          SET status = 'ended', runtime_status = 'ended', ended_at = now(), updated_at = now()
          WHERE id = ANY($1::text[]) AND customer_id = $2
        `, [switched.endedSubscriptionIds, user.id]);
      }
      const activeCount = Number((await client.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM strategy_subscriptions
        WHERE customer_id = $1 AND status = 'active'
      `, [user.id])).rows[0]?.count || 0);
      const existing = (await client.query<{ id: string }>(`
        SELECT id FROM strategy_subscriptions
        WHERE strategy_id = $1 AND customer_id = $2
        FOR UPDATE
      `, [mapped.strategy_id, user.id])).rows[0];
      if (!existing && activeCount >= membership.maxActiveStrategies) {
        throw new ResearchApiError("ACTIVE_STRATEGY_LIMIT", `当前会员最多同时运行 ${membership.maxActiveStrategies} 个策略`, 409);
      }
      subscriptionId = existing?.id ?? crypto.randomUUID();
      const activatedAt = new Date().toISOString();
      await client.query(`
        INSERT INTO strategy_subscriptions (
          id, strategy_id, customer_id, exchange_account_id, capital_pct, stop_loss_pct,
          execution_mode, status, risk_consent_at, started_at,
          strategy_version_id, run_mode, runtime_status, risk_check_json
        ) VALUES ($1, $2, $3, $4, $5, $6, 'proportional', 'active', $7, $7, $8, $9, 'active', $10)
        ON CONFLICT (strategy_id, customer_id) DO UPDATE SET
          exchange_account_id = EXCLUDED.exchange_account_id,
          capital_pct = EXCLUDED.capital_pct,
          stop_loss_pct = EXCLUDED.stop_loss_pct,
          status = 'active', risk_consent_at = EXCLUDED.risk_consent_at,
          strategy_version_id = EXCLUDED.strategy_version_id,
          run_mode = EXCLUDED.run_mode, runtime_status = 'active',
          risk_check_json = EXCLUDED.risk_check_json, ended_at = NULL,
          updated_at = EXCLUDED.risk_consent_at
      `, [
        subscriptionId, mapped.strategy_id, user.id, null, definition.risk.maxAssetAllocationPct, 0,
        activatedAt, mapped.strategy_version_id, mode,
        JSON.stringify({ code, symbol, mode, product: "spot_usdt", risk: definition.risk, customerExchangeAccountUsed: false, realOrderRoutingEnabled: false }),
      ]);
      deployment = await createStrategyDeployment(client, {
        ownerUserId: user.id,
        strategyId: mapped.strategy_id,
        strategyVersionId: mapped.strategy_version_id,
        strategySubscriptionId: subscriptionId,
        exchangeAccountId: null,
        mode,
        validationLabel: "UNVERIFIED",
        idempotencyKey: `platform-follow:${code}:${symbol}:${mode}`,
        riskAcknowledged: true,
        positionSizePct: null,
        stopLossPctOverride: null,
        executionProduct: "spot_usdt",
        platformStrategyCode: code,
        membershipId: membership.id,
        paperPortfolioId: portfolio.id,
      });
      const reactivated = await client.query(`
        UPDATE strategy_deployments
        SET status = 'active', next_cycle_at = now(),
            lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = NULL, last_error_message = NULL,
            updated_at = now()
        WHERE id = $1 AND owner_user_id = $2
        RETURNING id
      `, [deployment.id, user.id]);
      if (!reactivated.rows[0]) throw new Error("平台策略部署激活失败");
      deployment = { ...deployment, status: "active" };
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "platform_strategy.runtime.activated",
      subjectType: "strategy_deployment",
      subjectId: deployment.id,
      afterJson: JSON.stringify({ code, symbol, mode, strategyId: mapped.strategy_id, strategyVersionId: mapped.strategy_version_id, product: "spot_usdt", risk: definition.risk, customerExchangeAccountUsed: false, realOrderRoutingEnabled: false }),
    });
    return Response.json({
      subscriptionId,
      deployment,
      strategy: { ...definition, symbol },
      message: mode === "shadow" ? "平台策略影子运行已启动" : "平台策略模拟盘已启动",
    }, { status: 202 });
  } catch (error) {
    if (error instanceof OfficialStrategyModeSwitchOpenPositionError) {
      return researchErrorResponse(new ResearchApiError(
        "OPEN_POSITION_EXISTS",
        error.message,
        409,
      ), request);
    }
    if (error instanceof StrategyDeploymentIdempotencyConflictError) {
      return researchErrorResponse(new ResearchApiError(
        "IDEMPOTENCY_CONFLICT",
        "该平台策略已有不同卡片、交易对或模式的运行记录，请先停止原部署后创建新的运行配置",
        409,
      ), request);
    }
    return researchErrorResponse(error, request);
  }
}
