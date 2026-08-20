import { requireAccessPermission } from "@/lib/access-control";
import { commercialListInput } from "@/lib/commercial-api";
import { encodeCommercialCursor } from "@/lib/commercial-api-support";
import { loadMaintenanceTechnicalAudit } from "@/lib/maintenance-technical-audit";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.audit.view");
    const { url, limit, cursor } = commercialListInput(request);
    const rows = await loadMaintenanceTechnicalAudit(await getPostgresPool(), {
      limit,
      cursor,
      operation: url.searchParams.get("operation")?.trim() || null,
      status: url.searchParams.get("status")?.trim() || null,
    });
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    const nextCursor = rows.length > limit && last
      ? encodeCommercialCursor({ createdAt: last.createdAt, id: last.id })
      : null;
    return Response.json(
      { data, page: { limit, nextCursor } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
