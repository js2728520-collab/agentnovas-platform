import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { customerAttributions, tradingEmergencyStops, users } from "@/db/schema";
export { emergencyScopeForAccess, organizationEmergencyScopeKey, type TradingEmergencyScope } from "@/lib/trading-emergency-scope";
import { organizationEmergencyScopeKey } from "@/lib/trading-emergency-scope";

export async function isCustomerTradingEmergencyStopped(customerId: string) {
  const db = getDb();
  const customer = (await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, customerId)).limit(1))[0];
  if (!customer) return false;
  const attribution = (await db.select({ branchId: customerAttributions.branchId })
    .from(customerAttributions)
    .where(and(eq(customerAttributions.customerId, customerId), eq(customerAttributions.status, "active")))
    .orderBy(desc(customerAttributions.effectiveAt))
    .limit(1))[0];
  const organizationId = attribution?.branchId || customer.organizationId;
  const scopeKeys = ["platform", organizationId ? organizationEmergencyScopeKey(organizationId) : ""].filter(Boolean);
  const states = await db.select({ scopeKey: tradingEmergencyStops.scopeKey })
    .from(tradingEmergencyStops)
    .where(and(eq(tradingEmergencyStops.active, true), inArray(tradingEmergencyStops.scopeKey, scopeKeys)));
  return states.length > 0;
}
