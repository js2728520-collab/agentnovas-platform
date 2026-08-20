import { requireAccessPermission } from "@/lib/access-control";
import { readClientCreditBalance } from "@/lib/client-credit-view";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.credits.view");
    const pool = await getPostgresPool();
    const credits = await readClientCreditBalance(pool, user.id);
    return Response.json({ credits }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
