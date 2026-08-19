import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, customerAttributions, exchangeAccounts, platformStrategySubscriptions, strategySubscriptions, tradingEmergencyStops, trades, users } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { organizationEmergencyScopeKey } from "@/lib/trading-emergency";
import { closeOkxDemoTrade, type EmergencyCloseResult } from "@/lib/trading-emergency-close";
import { requireUser, responseError } from "@/lib/session";

async function scopeFor(request: Request) {
  const actor = await requireUser(request, ["hq_admin", "branch_admin"]);
  if (actor.role === "branch_admin" && !actor.organizationId) throw new Error("当前分公司账号未绑定组织");
  return {
    actor,
    scopeKey: actor.role === "hq_admin" ? "platform" : organizationEmergencyScopeKey(actor.organizationId!),
    scopeType: actor.role === "hq_admin" ? "platform" as const : "organization" as const,
    organizationId: actor.role === "hq_admin" ? null : actor.organizationId,
    label: actor.role === "hq_admin" ? "全部分公司客户" : "当前分公司客户",
  };
}

async function scopedCustomerIds(scopeType: "platform" | "organization", organizationId: string | null) {
  const db = getDb();
  if (scopeType === "platform") {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, "customer"));
    return [...new Set(rows.map((row) => row.id))];
  }
  const [directRows, attributedRows] = await Promise.all([
    db.select({ id: users.id }).from(users).where(and(eq(users.role, "customer"), eq(users.organizationId, organizationId))),
    db.select({ id: users.id }).from(users).innerJoin(customerAttributions, eq(customerAttributions.customerId, users.id)).where(and(eq(users.role, "customer"), eq(customerAttributions.branchId, organizationId!), eq(customerAttributions.status, "active"))),
  ]);
  return [...new Set([...directRows, ...attributedRows].map((row) => row.id))];
}

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    const scope = await scopeFor(request);
    const db = getDb();
    const state = (await db.select().from(tradingEmergencyStops).where(eq(tradingEmergencyStops.scopeKey, scope.scopeKey)).limit(1))[0];
    const customerIds = await scopedCustomerIds(scope.scopeType, scope.organizationId);
    return Response.json({ active: Boolean(state?.active), scope: scope.scopeType, scopeLabel: scope.label, affectedCustomers: customerIds.length, activatedAt: state?.activatedAt || null, deactivatedAt: state?.deactivatedAt || null }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    const scope = await scopeFor(request);
    const body = await request.json().catch(() => ({})) as { active?: boolean; closePositions?: boolean; reason?: string };
    if (typeof body.active !== "boolean") return Response.json({ error: "缺少紧急停止状态" }, { status: 400 });
    const db = getDb();
    const now = new Date().toISOString();
    const closePositions = body.active === true && body.closePositions === true;
    const reason = String(body.reason || (body.active ? (closePositions ? "后台手动紧急停止并强制平仓" : "后台手动紧急停止，仅暂停新开仓") : "后台手动解除紧急停止")).trim().slice(0, 240);
    const customerIds = await scopedCustomerIds(scope.scopeType, scope.organizationId);
    const existing = (await db.select().from(tradingEmergencyStops).where(eq(tradingEmergencyStops.scopeKey, scope.scopeKey)).limit(1))[0];
    const stateValues = {
      scopeKey: scope.scopeKey,
      scopeType: scope.scopeType,
      organizationId: scope.organizationId,
      active: body.active,
      reason,
      activatedByUserId: scope.actor.id,
      activatedAt: body.active ? now : existing?.activatedAt || null,
      deactivatedAt: body.active ? null : now,
      updatedAt: now,
    };
    const operations = [
      existing
        ? db.update(tradingEmergencyStops).set(stateValues).where(eq(tradingEmergencyStops.id, existing.id))
        : db.insert(tradingEmergencyStops).values({ id: crypto.randomUUID(), ...stateValues }),
    ];
    if (body.active && customerIds.length) {
      operations.push(db.update(strategySubscriptions).set({ status: "paused", updatedAt: now }).where(and(eq(strategySubscriptions.status, "active"), inArray(strategySubscriptions.customerId, customerIds))) as never);
      operations.push(db.update(platformStrategySubscriptions).set({ status: "paused", updatedAt: now }).where(and(eq(platformStrategySubscriptions.status, "active"), inArray(platformStrategySubscriptions.customerId, customerIds))) as never);
    }
    operations.push(db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: scope.actor.id, action: body.active ? "trading.emergency_stop.scope_activated" : "trading.emergency_stop.scope_deactivated", subjectType: scope.scopeType === "platform" ? "platform_trading_control" : "organization_trading_control", subjectId: scope.organizationId || "platform", afterJson: JSON.stringify({ scope: scope.scopeType, organizationId: scope.organizationId, affectedCustomers: customerIds.length, closePositions, reason }) }) as never);
    await db.batch(operations as never);
    const closeResults: EmergencyCloseResult[] = [];
    if (closePositions && customerIds.length) {
      const openPositions = await db.select().from(trades).where(and(inArray(trades.customerId, customerIds), isNull(trades.closedAt)));
      for (const position of openPositions) {
        const account = (await db.select().from(exchangeAccounts).where(and(eq(exchangeAccounts.id, position.exchangeAccountId), eq(exchangeAccounts.customerId, position.customerId))).limit(1))[0];
        if (!account) closeResults.push({ tradeId: position.id, symbol: position.symbol, status: "failed", message: "绑定账户不存在" });
        else if (position.executionVenue === "okx_demo" && account.environment === "demo" && account.status === "active" && account.canTrade) closeResults.push(await closeOkxDemoTrade(position, account, now));
        else closeResults.push({ tradeId: position.id, symbol: position.symbol, status: "unsupported", message: "该仓位的交易所平仓路由尚未接通，未标记为已平仓" });
      }
    }
    const closed = closeResults.filter((result) => result.status === "closed").length;
    const pending = closeResults.filter((result) => result.status === "pending").length;
    const blocked = closeResults.filter((result) => result.status === "unsupported" || result.status === "failed").length;
    return Response.json({ active: body.active, scope: scope.scopeType, scopeLabel: scope.label, affectedCustomers: customerIds.length, pausedNewEntries: body.active, closePositions, openPositions: closeResults.length, closed, pending, blocked, results: closeResults, message: body.active ? (closePositions ? `已停止${scope.label}的新开仓，并执行强制平仓；${closed} 个已平仓${pending ? `，${pending} 个等待成交` : ""}${blocked ? `，${blocked} 个无法真实平仓` : ""}` : `已停止${scope.label}的新开仓，当前仓位保留`) : `已解除${scope.label}的紧急停止，可由客户或后台重新恢复策略` });
  } catch (error) {
    return responseError(error);
  }
}
