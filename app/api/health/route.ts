import { getDb } from "@/db";

export async function GET() {
  let database = "ok";
  try {
    getDb();
  } catch {
    database = "missing";
  }

  const encryptionKey = Boolean(
    process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY
      && process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY.length >= 32,
  );
  const automationKey = Boolean(
    process.env.AUTOMATION_INTERNAL_SECRET
      && process.env.AUTOMATION_INTERNAL_SECRET.length >= 24,
  );
  const aiProvider = Boolean(
    process.env.AI_API_URL
      && process.env.AI_API_KEY
      && process.env.AI_MODEL,
  );
  const marketData = Boolean(process.env.MARKET_DATA_BASE_URL || "https://api-gcp.binance.com");

  return Response.json({
    status: database === "ok" && encryptionKey ? "ready" : "degraded",
    mode: "research-only",
    checks: {
      database,
      encryptionKey,
      automationKey,
      aiProvider,
      marketData,
      marketProvider: process.env.MARKET_DATA_PROVIDER || "Binance Spot REST",
      emergencyStop: process.env.PLATFORM_EMERGENCY_STOP === "true",
      liveTradingEnabled: false,
    },
    timestamp: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}
