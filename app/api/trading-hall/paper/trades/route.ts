import { requireAccessPermission } from "@/lib/access-control";
import { listOfficialPaperTrades } from "@/lib/official-paper-repository";
import { officialPaperTradeDto } from "@/lib/official-paper-public-contract";
import { cursorPage } from "@/lib/commercial-public-contract";
import { parseOfficialPaperTradeLimit } from "@/lib/official-paper-pagination";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

type TradeCursor = { filledAt: string; id: string };

function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TradeCursor>;
    if (!parsed.filledAt || !parsed.id || parsed.id.length > 128 || Number.isNaN(Date.parse(parsed.filledAt))) {
      throw new Error("invalid cursor");
    }
    return { filledAt: new Date(parsed.filledAt), id: parsed.id };
  } catch {
    throw new ResearchApiError("VALIDATION_ERROR", "模拟成交游标无效", 422, { fields: ["cursor"] });
  }
}

function encodeCursor(value: { filledAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ filledAt: value.filledAt.toISOString(), id: value.id }), "utf8").toString("base64url");
}

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.paper.view");
    const url = new URL(request.url);
    const limit = parseOfficialPaperTradeLimit(url.searchParams.get("limit"));
    const result = await listOfficialPaperTrades(await getPostgresPool(), {
      customerId: user.id,
      cursor: decodeCursor(url.searchParams.get("cursor")),
      limit,
    });
    const nextCursor = result.nextCursor ? encodeCursor(result.nextCursor) : null;
    return Response.json(
      cursorPage(result.items.map(officialPaperTradeDto), limit, nextCursor),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
