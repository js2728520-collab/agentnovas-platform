import { requireAccessPermission } from "@/lib/access-control";
import {
  resendEmailTestRecipientVerification,
  verifyEmailTestRecipient,
} from "@/lib/email-test-recipient-management";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { maintenanceIdempotencyKeyHash, runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { normalizeEmailRecipientVerificationCommand } from "@/packages/notifications/src/email-service-management";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    const { id: recipientId } = await context.params;
    let command;
    try {
      command = normalizeEmailRecipientVerificationCommand(await readResearchJson(request, 2_048));
    } catch (error) {
      const code = error instanceof Error ? error.message : "EMAIL_RECIPIENT_VERIFICATION_FIELDS_INVALID";
      throw new ResearchApiError(code, "验证码动作、验证码或变更原因无效", 422);
    }
    const correlation = maintenanceCorrelation(request);
    const responseRequestId = correlation.requestId ?? crypto.randomUUID();
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    const idempotencyHash = maintenanceIdempotencyKeyHash(idempotencyKey);
    type VerificationResponse = Awaited<ReturnType<typeof verifyEmailTestRecipient>>
      | Awaited<ReturnType<typeof resendEmailTestRecipientVerification>>
      | { error: { code: string; message: string; details: Record<string, unknown> }; requestId: string };
    const result = await runMaintenanceIdempotentCommand<VerificationResponse>(await getPostgresPool(), {
      operation: "maintenance.email_recipient.verify",
      actorUserId: user.id,
      subjectType: "notification_email_test_recipient",
      subjectId: recipientId,
      idempotencyKey,
      payload: command,
      ...correlation,
      requestId: responseRequestId,
    }, async (client) => {
      try {
        const response = command.action === "verify"
          ? await verifyEmailTestRecipient(client, {
            actorUserId: user.id,recipientId,code: command.code,reason: command.reason,request,
          })
          : await resendEmailTestRecipientVerification(client, {
            actorUserId: user.id,recipientId,reason: command.reason,request,idempotencyHash,
          });
        return { terminalStatus: "succeeded", responseStatus: 200, response } as const;
      } catch (error) {
        if (!(error instanceof ResearchApiError)) throw error;
        return {
          terminalStatus: "failed",responseStatus: error.status,errorCode: error.code,
          response: { error: { code: error.code,message: error.message,details: error.details },requestId: responseRequestId },
        } as const;
      }
    });
    return Response.json(result.response, {
      status: result.responseStatus,
      headers: { "cache-control": "no-store","idempotency-replayed": String(result.replayed),"x-request-id": responseRequestId },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
