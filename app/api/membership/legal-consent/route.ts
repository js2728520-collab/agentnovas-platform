import { requireUser } from "@/lib/session";
import { commercialJson, idempotencyKey, stringArray } from "@/lib/commercial-api";
import { acceptCurrentCommercialLegalDocuments, readCommercialLegalConsent } from "@/lib/commercial-membership-service";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { clientIpFromRequest } from "@/lib/riverton-apps";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request, ["customer"]);
    const status = await readCommercialLegalConsent(await getPostgresPool(), user.id);
    return Response.json(status, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request, ["customer"]);
    const body = await commercialJson(request);
    const status = await acceptCurrentCommercialLegalDocuments(await getPostgresPool(), {
      userId: user.id,
      acceptedDocumentVersionIds: stringArray(body, "acceptedDocumentVersionIds", 7),
      idempotencyKey: idempotencyKey(request),
      trustedIp: clientIpFromRequest(request),
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return Response.json(status, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
