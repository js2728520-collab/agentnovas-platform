import { requireAccessPermission } from "@/lib/access-control";
import { listOfficialPaperPortfolios } from "@/lib/official-paper-repository";
import { officialPaperPortfolioDto } from "@/lib/official-paper-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.paper.view");
    const pool = await getPostgresPool();
    const portfolios = await listOfficialPaperPortfolios(pool, user.id);
    return Response.json({ data: portfolios.map(officialPaperPortfolioDto) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
