import { requireAnyAccessPermission } from "@/lib/access-control";
import { listMaintenanceSourceIntegrations } from "@/lib/maintenance-integration-catalog";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.feature_flags.manage"]);
    return Response.json({ integrations: await listMaintenanceSourceIntegrations(await getPostgresPool()) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
