import { requireAccessPermission } from "@/lib/access-control";
import { commercialJson, idempotencyKey } from "@/lib/commercial-api";
import { decideCommercialDisclosure } from "@/lib/commercial-disclosure-service";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { ResearchApiError } from "@/lib/research-errors";

const APPROVE_PERMISSION = "maint.commercial_disclosures.approve";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, APPROVE_PERMISSION);
    const { id } = await params;
    const body = await commercialJson(request);
    const decision = body.decision;
    if (decision !== "approve" && decision !== "reject") throw new ResearchApiError("DISCLOSURE_DECISION_INVALID", "复核决定必须是 approve 或 reject", 422);
    const note = typeof body.note === "string" ? body.note : "";
    return Response.json(await decideCommercialDisclosure(await getPostgresPool(), {
      requestId: id,
      reviewerUserId: user.id,
      decision,
      note,
      idempotencyKey: idempotencyKey(request),
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
