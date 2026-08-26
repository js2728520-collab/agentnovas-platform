import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey } from "@/lib/commercial-api";
import { readCommercialDisclosureControl, submitCommercialDisclosure } from "@/lib/commercial-disclosure-service";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

const VIEW_PERMISSION = "maint.commercial_disclosures.view";
const SUBMIT_PERMISSION = "maint.commercial_disclosures.submit";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, VIEW_PERMISSION);
    return Response.json(await readCommercialDisclosureControl(await getPostgresPool()), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, SUBMIT_PERMISSION);
    const body = await commercialJson(request, 1_500_000);
    const result = await submitCommercialDisclosure(await getPostgresPool(), {
      actorUserId: user.id,
      idempotencyKey: idempotencyKey(request),
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      submission: body,
    });
    return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
