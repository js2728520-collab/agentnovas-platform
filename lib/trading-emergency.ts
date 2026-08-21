import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { customerAttributions, tradingEmergencyStops, users } from "@/db/schema";
export { emergencyScopeForAccess, organizationEmergencyScopeKey, type TradingEmergencyScope } from "@/lib/trading-emergency-scope";
import { organizationEmergencyScopeKey } from "@/lib/trading-emergency-scope";

export async function isCustomerTradingEmergencyStopped(customerId: string) {
  const db = getDb();
  const customer = (await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, customerId)).limit(1))[0];
  if (!customer) return false;
  const attributions = await db.select({ branchId: customerAttributions.branchId })
    .from(customerAttributions)
    .where(and(eq(customerAttributions.customerId, customerId), eq(customerAttributions.status, "active")));
  const organizationIds = new Set([
    customer.organizationId,
    ...attributions.map((attribution) => attribution.branchId),
  ].filter((organizationId): organizationId is string => Boolean(organizationId)));
  const scopeKeys = ["platform", ...[...organizationIds].map(organizationEmergencyScopeKey)];
  const states = await db.select({ scopeKey: tradingEmergencyStops.scopeKey })
    .from(tradingEmergencyStops)
    .where(and(eq(tradingEmergencyStops.active, true), inArray(tradingEmergencyStops.scopeKey, scopeKeys)));
  return states.length > 0;
}
