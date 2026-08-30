import { requireAccessPermission } from "@/lib/access-control";
import { createEmailTestRecipient, listEmailTestRecipients } from "@/lib/email-test-recipient-management";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { maintenanceIdempotencyKeyHash, runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { normalizeEmailRecipientCreateCommand } from "@/packages/notifications/src/email-service-management";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.email_integrations.manage");
    const recipients = await listEmailTestRecipients(await getPostgresPool());
    return Response.json({ recipients }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    let command;
    try {
      command = normalizeEmailRecipientCreateCommand(await readResearchJson(request, 4_096));
    } catch (error) {
      const code = error instanceof Error ? error.message : "EMAIL_RECIPIENT_FIELDS_INVALID";
      throw new ResearchApiError(code, "测试收件地址、标签或变更原因无效", 422);
    }
    const correlation = maintenanceCorrelation(request);
    const responseRequestId = correlation.requestId ?? crypto.randomUUID();
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    const idempotencyHash = maintenanceIdempotencyKeyHash(idempotencyKey);
    type CommandResponse = Awaited<ReturnType<typeof createEmailTestRecipient>> | {
      error: { code: string; message: string; details: Record<string, unknown> };
      requestId: string;
    };
    const result = await runMaintenanceIdempotentCommand<CommandResponse>(await getPostgresPool(), {
      operation: "maintenance.email_recipient.create",
      actorUserId: user.id,
      subjectType: "notification_email_test_recipient",
      subjectId: command.email,
      idempotencyKey,
      payload: command,
      ...correlation,
      requestId: responseRequestId,
    }, async (client) => {
      try {
        const response = await createEmailTestRecipient(client, {
          actorUserId: user.id,
          ...command,
          request,
          idempotencyHash,
        });
        return { terminalStatus: "succeeded", responseStatus: 201, response } as const;
      } catch (error) {
        if (!(error instanceof ResearchApiError)) throw error;
        return {
          terminalStatus: "failed",
          responseStatus: error.status,
          errorCode: error.code,
          response: {
            error: { code: error.code, message: error.message, details: error.details },
            requestId: responseRequestId,
          },
        } as const;
      }
    });
    return Response.json(result.response, {
      status: result.responseStatus,
      headers: {
        "cache-control": "no-store",
        "idempotency-replayed": String(result.replayed),
        "x-request-id": responseRequestId,
      },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
