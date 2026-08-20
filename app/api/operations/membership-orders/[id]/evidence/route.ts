import { requireAccessPermission } from "@/lib/access-control";
import {
  commercialJson,
  idempotencyKey,
  paymentEvidenceInput,
} from "@/lib/commercial-api";
import { recordMembershipPaymentEvidence } from "@/lib/commercial-membership-service";
import { paymentEvidenceDto } from "@/lib/commercial-public-contract";
import { assertOperationsOrderScope } from "@/lib/commercial-operations-scope";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, scope } = await requireAccessPermission(
      request,
      "ops.membership_orders.evidence",
    );
    const { id } = await params;
    const b = await commercialJson(request);
    const evidenceInput = paymentEvidenceInput(b, "USD");
    const pool = await getPostgresPool();
    await assertOperationsOrderScope(
      pool,
      scope,
      { userId: user.id, organizationId: user.organizationId },
      id,
    );
    const evidence = await recordMembershipPaymentEvidence(pool, {
      orderId: id,
      actorUserId: user.id,
      ...evidenceInput,
      idempotencyKey: idempotencyKey(request),
    });
    return Response.json(
      { evidence: paymentEvidenceDto(evidence) },
      { status: 201 },
    );
  } catch (error) {
    return researchErrorResponse(error);
  }
}
