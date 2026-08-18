import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { exchangeAccounts, trades } from "@/db/schema";
import { marketDataIsHealthy } from "@/lib/market-data";
import { getPlatformSetting } from "@/lib/platform-settings";
import { requireUser, responseError } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const me = await requireUser(request, ["customer"]);
    const db = getDb();
    const [accounts, rows, security] = await Promise.all([
      db.select().from(exchangeAccounts).where(eq(exchangeAccounts.customerId, me.id)),
      db.select().from(trades).where(eq(trades.customerId, me.id)),
      getPlatformSetting("security"),
    ]);
    const open = rows.filter((row) => !row.closedAt);
    const today = new Date().toISOString().slice(0, 10);
    const todayPnl = rows.filter((row) => (row.closedAt || row.updatedAt || "").startsWith(today)).reduce((total, row) => total + row.realizedNetPnlUsdt, 0);
    const positionValue = open.reduce((total, row) => total + row.entryValueUsdt, 0);
    const marketFresh = await marketDataIsHealthy();
    const emergencyStop = security.emergencyStop || process.env.PLATFORM_EMERGENCY_STOP === "true";
    const checks = [
      { key: "account_active", label: "交易账户状态", ok: accounts.some((account) => account.environment === "demo" && account.status === "active") },
      { key: "stale_data", label: "行情数据新鲜度", ok: marketFresh },
      { key: "daily_loss", label: "单日亏损限制", ok: todayPnl >= -3000, value: todayPnl },
      { key: "position_limit", label: "总仓位限制", ok: positionValue <= 10000, value: positionValue },
      { key: "circuit_breaker", label: emergencyStop ? "平台紧急停止" : "账户熔断状态", ok: !emergencyStop },
    ];
    return Response.json({ allowed: checks.every((check) => check.ok), checks, summary: { openPositions: open.length, positionValue, todayPnl, accounts: accounts.length }, updatedAt: new Date().toISOString() });
  } catch (error) { return responseError(error); }
}
