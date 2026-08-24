import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { loadClientStrategyWorkRecord } from "@/lib/strategy-work-records";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAccessPermission(request, "client.paper.view");
    const { id } = await params;
    const record = await loadClientStrategyWorkRecord(await getPostgresPool(), {
      userId: user.id,
      recordId: id,
    });
    return Response.json(record, {
      headers: { "cache-control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
