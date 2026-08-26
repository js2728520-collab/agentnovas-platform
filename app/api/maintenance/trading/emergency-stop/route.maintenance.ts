import type { Pool, PoolClient } from "pg";

import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { restrictOfficialPaperPortfoliosForEmergency } from "@/lib/official-paper-repository";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { emergencyScopeForAccess } from "@/lib/trading-emergency";

const PERMISSION = "maint.emergency_pause.execute";
const DEMO_CONTROL_PATH = "/integrations/demo-exchanges";

async function requestScope(request: Request) {
  const access = await requireAccessPermission(request, PERMISSION);
  const scope = emergencyScopeForAccess(access.scope, access.user.organizationId);
  if (!scope) throw new ResearchApiError("EMERGENCY_SCOPE_UNAVAILABLE", "当前授权没有可执行的组织范围", 403);
  return {
    ...access,
    ...scope,
    label: scope.scopeType === "platform" ? "全部客户" : "当前组织客户",
  };
}

async function scopedCustomerIds(database: Pool | PoolClient, scopeType: "platform" | "organization", organizationId: string | null) {
  const result = await database.query<{ id: string }>(`
    SELECT DISTINCT customer.id
      FROM users AS customer
     WHERE customer.role='customer'
       AND ($1::text='platform' OR (
         $2::text IS NOT NULL AND (
           customer.organization_id=$2 OR EXISTS (
             SELECT 1 FROM customer_attributions AS attribution
              WHERE attribution.customer_id=customer.id
                AND attribution.branch_id=$2
                AND attribution.status='active'
           )
         )
       ))
     ORDER BY customer.id
  `, [scopeType, organizationId]);
  return result.rows.map((row) => row.id);
}

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const scope = await requestScope(request);
    const pool = await getPostgresPool();
    const [stateResult, customerIds] = await Promise.all([
      pool.query<{
        active: boolean;
        reason: string;
        activatedAt: string | null;
        deactivatedAt: string | null;
      }>(`
        SELECT active,reason,activated_at AS "activatedAt",deactivated_at AS "deactivatedAt"
          FROM trading_emergency_stops
         WHERE scope_key=$1
         LIMIT 1
      `, [scope.scopeKey]),
      scopedCustomerIds(pool, scope.scopeType, scope.organizationId),
    ]);
    const paperResult = customerIds.length
      ? await pool.query<{ accessStatus: "active" | "close_only" | "read_only"; count: number }>(`
          SELECT access_status AS "accessStatus",count(*)::int AS count
            FROM official_paper_portfolios
           WHERE customer_id=ANY($1::text[])
           GROUP BY access_status
        `, [customerIds])
      : { rows: [] };
    const paperCounts = new Map(paperResult.rows.map((row) => [row.accessStatus, row.count]));
    const state = stateResult.rows[0];
    return Response.json({
      active: Boolean(state?.active),
      scope: scope.scopeType,
      scopeLabel: scope.label,
      affectedCustomers: customerIds.length,
      affectedPortfolios: [...paperCounts.values()].reduce((total, count) => total + count, 0),
      activePortfolios: paperCounts.get("active") || 0,
      closeOnlyPortfolios: paperCounts.get("close_only") || 0,
      readOnlyPortfolios: paperCounts.get("read_only") || 0,
      reason: state?.reason || "",
      activatedAt: state?.activatedAt || null,
      deactivatedAt: state?.deactivatedAt || null,
      paperAccessOnly: true,
      platformDemoUnaffected: true,
      demoControlPath: DEMO_CONTROL_PATH,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const scope = await requestScope(request);
    const body = await readResearchJson(request, 4_096);
    if (typeof body.active !== "boolean") throw new ResearchApiError("VALIDATION_ERROR", "缺少紧急暂停状态", 422, { fields: ["active"] });
    const reason = String(body.reason ?? "").trim();
    if (reason.length < 3) throw new ResearchApiError("VALIDATION_ERROR", "必须填写紧急暂停原因（至少 3 个字符）", 422, { fields: ["reason"] });
    if (reason.length > 240) throw new ResearchApiError("VALIDATION_ERROR", "紧急暂停原因不能超过 240 个字符", 422, { fields: ["reason"] });

    const now = new Date();
    const correlation = maintenanceCorrelation(request);
    const command = await runMaintenanceIdempotentCommand(await getPostgresPool(), {
      operation: "maintenance.trading.emergency_stop",
      actorUserId: scope.user.id,
      subjectType: scope.scopeType === "platform" ? "platform_trading_control" : "organization_trading_control",
      subjectId: scope.organizationId || "platform",
      idempotencyKey: idempotencyKey(request),
      payload: {
        active: body.active,
        reason,
        scope: scope.scopeType,
        organizationId: scope.organizationId,
      },
      ...correlation,
    }, async (client) => {
      const customerIds = await scopedCustomerIds(client, scope.scopeType, scope.organizationId);
      await client.query(`
        INSERT INTO trading_emergency_stops(
          id,scope_key,scope_type,organization_id,active,reason,activated_by_user_id,
          activated_at,deactivated_at,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT(scope_key) DO UPDATE SET
          scope_type=EXCLUDED.scope_type,
          organization_id=EXCLUDED.organization_id,
          active=EXCLUDED.active,
          reason=EXCLUDED.reason,
          activated_by_user_id=EXCLUDED.activated_by_user_id,
          activated_at=CASE WHEN EXCLUDED.active THEN EXCLUDED.activated_at ELSE trading_emergency_stops.activated_at END,
          deactivated_at=EXCLUDED.deactivated_at,
          updated_at=EXCLUDED.updated_at
      `, [
        crypto.randomUUID(), scope.scopeKey, scope.scopeType, scope.organizationId, body.active,
        reason, scope.user.id, body.active ? now : null, body.active ? null : now, now,
      ]);

      const emergencyRestriction = body.active
        ? await restrictOfficialPaperPortfoliosForEmergency(client, { customerIds, now })
        : { changedPortfolios: [], rejectedPendingBuys: 0 };
      const { changedPortfolios, rejectedPendingBuys } = emergencyRestriction;
      const closeOnlyPortfolios = changedPortfolios.filter((row) => row.accessStatus === "close_only").length;
      const readOnlyPortfolios = changedPortfolios.filter((row) => row.accessStatus === "read_only").length;
      const auditDetails = {
        scope: scope.scopeType,
        organizationId: scope.organizationId,
        affectedCustomers: customerIds.length,
        affectedPortfolios: changedPortfolios.length,
        closeOnlyPortfolios,
        readOnlyPortfolios,
        rejectedPendingBuys,
        paperAccessOnly: true,
        platformDemoUnaffected: true,
        reason,
      };
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id,trace_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        crypto.randomUUID(),
        scope.user.id,
        body.active ? "trading.emergency_stop.scope_activated" : "trading.emergency_stop.scope_deactivated",
        scope.scopeType === "platform" ? "platform_trading_control" : "organization_trading_control",
        scope.organizationId || "platform",
        JSON.stringify(auditDetails),
        correlation.requestId,
        correlation.traceId,
        now.toISOString(),
      ]);
      return {
        terminalStatus: "succeeded",
        responseStatus: 200,
        response: {
          active: body.active,
          scope: scope.scopeType,
          scopeLabel: scope.label,
          affectedCustomers: customerIds.length,
          affectedPortfolios: changedPortfolios.length,
          closeOnlyPortfolios,
          readOnlyPortfolios,
          rejectedPendingBuys,
          pausedNewEntries: body.active,
          paperAccessOnly: true,
          platformDemoUnaffected: true,
          demoControlPath: DEMO_CONTROL_PATH,
          message: body.active
            ? `已暂停${scope.label}的官方 Paper 新开仓；${closeOnlyPortfolios} 个组合仅允许平仓，${readOnlyPortfolios} 个组合已转为只读，${rejectedPendingBuys} 个待处理买入已拒绝。平台 Demo 控制未改变。`
            : `已解除${scope.label}的紧急暂停；官方 Paper 组合不会自动恢复，平台 Demo 控制未改变。`,
        },
      };
    });
    return Response.json(command.response, { headers: { "idempotency-replayed": String(command.replayed) } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
