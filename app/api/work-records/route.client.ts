import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import {
  listClientStrategyWorkRecords,
  parseStrategyWorkRecordListInput,
} from "@/lib/strategy-work-records";

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.paper.view");
    const input = parseStrategyWorkRecordListInput(new URL(request.url));
    const result = await listClientStrategyWorkRecords(await getPostgresPool(), {
      userId: user.id,
      ...input,
    });
    return Response.json(
      { data: result.data, page: { limit: input.limit, nextCursor: result.nextCursor } },
      { headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
