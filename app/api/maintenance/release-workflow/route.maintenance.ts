import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readRestrictedCicdMaintenance } from "@/lib/restricted-cicd-maintenance-service";
import { researchErrorResponse } from "@/lib/research-api";

const VIEW_PERMISSION = "maint.releases.workflow.view";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, VIEW_PERMISSION);
    const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw new Error("invalid limit");
    return Response.json(await readRestrictedCicdMaintenance(await getPostgresPool(), rawLimit), { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
