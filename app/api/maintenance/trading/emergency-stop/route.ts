import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import {
  auditLogs,
  customerAttributions,
  exchangeAccounts,
  platformStrategySubscriptions,
  strategySubscriptions,
  tradingEmergencyStops,
  trades,
  users,
} from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { closeOkxDemoTrade, type EmergencyCloseResult } from "@/lib/trading-emergency-close";
import { emergencyScopeForAccess } from "@/lib/trading-emergency";

const PERMISSION = "maint.emergency_pause.execute";

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

async function scopedCustomerIds(scopeType: "platform" | "organization", organizationId: string | null) {
  const db = getDb();
  if (scopeType === "platform") {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, "customer"));
    return [...new Set(rows.map((row) => row.id))];
  }
  if (!organizationId) return [];
  const [directRows, attributedRows] = await Promise.all([
    db.select({ id: users.id }).from(users).where(and(eq(users.role, "customer"), eq(users.organizationId, organizationId))),
    db.select({ id: users.id }).from(users)
      .innerJoin(customerAttributions, eq(customerAttributions.customerId, users.id))
      .where(and(eq(users.role, "customer"), eq(customerAttributions.branchId, organizationId), eq(customerAttributions.status, "active"))),
  ]);
  return [...new Set([...directRows, ...attributedRows].map((row) => row.id))];
}

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const scope = await requestScope(request);
    const state = (await getDb().select().from(tradingEmergencyStops).where(eq(tradingEmergencyStops.scopeKey, scope.scopeKey)).limit(1))[0];
    const customerIds = await scopedCustomerIds(scope.scopeType, scope.organizationId);
    return Response.json({
      active: Boolean(state?.active),
      scope: scope.scopeType,
      scopeLabel: scope.label,
      affectedCustomers: customerIds.length,
      reason: state?.reason || "",
      activatedAt: state?.activatedAt || null,
      deactivatedAt: state?.deactivatedAt || null,
      demoCloseOnly: true,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const scope = await requestScope(request);
    const body = await request.json().catch(() => ({})) as { active?: unknown; closePositions?: unknown; reason?: unknown };
    if (typeof body.active !== "boolean") throw new ResearchApiError("VALIDATION_ERROR", "缺少紧急暂停状态", 422, { fields: ["active"] });
    const reason = String(body.reason ?? "").trim();
    if (reason.length < 3) throw new ResearchApiError("VALIDATION_ERROR", "必须填写紧急暂停原因（至少 3 个字符）", 422, { fields: ["reason"] });
    if (reason.length > 240) throw new ResearchApiError("VALIDATION_ERROR", "紧急暂停原因不能超过 240 个字符", 422, { fields: ["reason"] });
    const closePositions = body.active && body.closePositions === true;
    const db = getDb();
    const now = new Date().toISOString();
    const customerIds = await scopedCustomerIds(scope.scopeType, scope.organizationId);
    const existing = (await db.select().from(tradingEmergencyStops).where(eq(tradingEmergencyStops.scopeKey, scope.scopeKey)).limit(1))[0];
    const nextState = {
      scopeKey: scope.scopeKey,
      scopeType: scope.scopeType,
      organizationId: scope.organizationId,
      active: body.active,
      reason,
      activatedByUserId: scope.user.id,
      activatedAt: body.active ? now : existing?.activatedAt || null,
      deactivatedAt: body.active ? null : now,
      updatedAt: now,
    } as const;
    const statements = [
      existing
        ? db.update(tradingEmergencyStops).set(nextState).where(eq(tradingEmergencyStops.id, existing.id))
        : db.insert(tradingEmergencyStops).values({ id: crypto.randomUUID(), ...nextState }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: scope.user.id,
        action: body.active ? "trading.emergency_stop.scope_activated" : "trading.emergency_stop.scope_deactivated",
        subjectType: scope.scopeType === "platform" ? "platform_trading_control" : "organization_trading_control",
        subjectId: scope.organizationId || "platform",
        afterJson: JSON.stringify({ scope: scope.scopeType, organizationId: scope.organizationId, affectedCustomers: customerIds.length, closePositions, demoCloseOnly: true, reason }),
      }),
    ];
    if (body.active && customerIds.length) {
      statements.push(db.update(strategySubscriptions).set({ status: "paused", updatedAt: now }).where(and(eq(strategySubscriptions.status, "active"), inArray(strategySubscriptions.customerId, customerIds))) as never);
      statements.push(db.update(platformStrategySubscriptions).set({ status: "paused", updatedAt: now }).where(and(eq(platformStrategySubscriptions.status, "active"), inArray(platformStrategySubscriptions.customerId, customerIds))) as never);
    }
    await db.batch(statements);

    const closeResults: EmergencyCloseResult[] = [];
    if (closePositions && customerIds.length) {
      const openPositions = await db.select().from(trades).where(and(inArray(trades.customerId, customerIds), isNull(trades.closedAt)));
      const accountIds = [...new Set(openPositions.map((position) => position.exchangeAccountId))];
      const accounts = accountIds.length
        ? await db.select().from(exchangeAccounts).where(and(inArray(exchangeAccounts.id, accountIds), inArray(exchangeAccounts.customerId, customerIds)))
        : [];
      const accountMap = new Map(accounts.map((account) => [`${account.customerId}:${account.id}`, account]));
      for (const position of openPositions) {
        const account = accountMap.get(`${position.customerId}:${position.exchangeAccountId}`);
        if (!account) closeResults.push({ tradeId: position.id, symbol: position.symbol, status: "failed", message: "绑定账户不存在" });
        else if (position.executionVenue === "okx_demo" && account.environment === "demo" && account.status === "active" && account.canTrade) closeResults.push(await closeOkxDemoTrade(position, account, now));
        else closeResults.push({ tradeId: position.id, symbol: position.symbol, status: "unsupported", message: "仅 OKX Demo 仓位可自动平仓；该仓位未被标记为已平仓" });
      }
    }
    const closed = closeResults.filter((result) => result.status === "closed").length;
    const pending = closeResults.filter((result) => result.status === "pending").length;
    const blocked = closeResults.filter((result) => result.status === "unsupported" || result.status === "failed").length;
    return Response.json({
      active: body.active,
      scope: scope.scopeType,
      scopeLabel: scope.label,
      affectedCustomers: customerIds.length,
      pausedNewEntries: body.active,
      closePositions,
      demoCloseOnly: true,
      openPositions: closeResults.length,
      closed,
      pending,
      blocked,
      results: closeResults,
      message: body.active
        ? closePositions
          ? `已暂停${scope.label}的新开仓，并处理 OKX Demo 仓位：${closed} 个已平仓，${pending} 个等待回执，${blocked} 个未执行`
          : `已暂停${scope.label}的新开仓，当前仓位保留`
        : `已解除${scope.label}的紧急暂停；策略不会自动恢复`,
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
