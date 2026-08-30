import { requireAnyAccessPermission } from "@/lib/access-control";
import { getAiControlPlaneSnapshot } from "@/lib/ai-control-plane-repository";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireAnyAccessPermission(request,[
      "maint.system_health.view","maint.llm_profiles.manage","maint.agent_bindings.manage","maint.ai_usage.view",
    ]);
    const snapshot = await getAiControlPlaneSnapshot(await getPostgresPool());
    const gatewayEnabled = process.env.AI_GATEWAY_ENABLED === "true";
    const researchEnabled = process.env.STRATEGY_RESEARCH_ENABLED === "true";
    const runtimeEnabled = process.env.STRATEGY_RUNTIME_ENABLED === "true";
    return Response.json({
      snapshot,
      runtime: {
        gateway: gatewayEnabled ? "active" : "disabled",
        research: researchEnabled ? gatewayEnabled ? "active" : "gated" : "retired",
        runtimeExplanation: runtimeEnabled && gatewayEnabled ? "active" : "gated",
      },
    },{ headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
