import { getDb } from "@/db";
import { runtimeSetting } from "@/lib/runtime-setting";

export async function GET() {
  let database = "ok";
  try {
    getDb();
  } catch {
    database = "missing";
  }

  const encryptionKey = Boolean(
    runtimeSetting("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY")
      && runtimeSetting("EXCHANGE_CREDENTIAL_ENCRYPTION_KEY")!.length >= 32,
  );
  const automationKey = Boolean(
    runtimeSetting("AUTOMATION_INTERNAL_SECRET")
      && runtimeSetting("AUTOMATION_INTERNAL_SECRET")!.length >= 24,
  );
  const aiProvider = Boolean(
    runtimeSetting("AI_API_URL")
      && runtimeSetting("AI_API_KEY")
      && runtimeSetting("AI_MODEL"),
  );
  const marketData = Boolean(runtimeSetting("MARKET_DATA_BASE_URL") || "https://api-gcp.binance.com");

  return Response.json({
    status: database === "ok" && encryptionKey ? "ready" : "degraded",
    mode: "validation-trading",
    checks: {
      database,
      encryptionKey,
      automationKey,
      aiProvider,
      marketData,
      marketProvider: runtimeSetting("MARKET_DATA_PROVIDER") || "Binance Spot REST",
      emergencyStop: runtimeSetting("PLATFORM_EMERGENCY_STOP") === "true",
      platformAiCycle: automationKey ? "scheduled" : "missing_automation_secret",
      liveTradingEnabled: false,
    },
    timestamp: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}
