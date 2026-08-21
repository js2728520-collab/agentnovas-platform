import { requireAccessPermission } from "@/lib/access-control";
import { loadClientDemoSummary } from "@/lib/client-demo-summary";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "client.paper.view");
    const summary = await loadClientDemoSummary(await getPostgresPool());
    return Response.json(summary, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
