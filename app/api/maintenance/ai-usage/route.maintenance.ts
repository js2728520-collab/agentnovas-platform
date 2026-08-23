import { requireAccessPermission } from "@/lib/access-control";
import {
  loadMaintenanceAiUsage,
  parseMaintenanceAiUsageWindow,
} from "@/lib/maintenance-ai-usage";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.ai_usage.view");
    const period = parseMaintenanceAiUsageWindow(new URL(request.url).searchParams);
    const report = await loadMaintenanceAiUsage(await getPostgresPool(), period);
    return Response.json(report, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
