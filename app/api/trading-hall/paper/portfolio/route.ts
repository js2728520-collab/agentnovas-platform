import { listOfficialPaperPortfolios } from "@/lib/official-paper-repository";
import { getPostgresPool } from "@/lib/postgres";
import { requireResearchUser, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const user = await requireResearchUser(request, ["customer"]);
    const pool = await getPostgresPool();
    const portfolios = await listOfficialPaperPortfolios(pool, user.id);
    return Response.json({ portfolios }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
