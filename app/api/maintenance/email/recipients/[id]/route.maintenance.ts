import { requireAccessPermission } from "@/lib/access-control";
import { deleteEmailTestRecipient, updateEmailTestRecipient } from "@/lib/email-test-recipient-management";
import { maintenanceCorrelation, maintenanceReason } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { normalizeEmailRecipientCommand } from "@/packages/notifications/src/email-service-management";

type ItemResponse = Awaited<ReturnType<typeof updateEmailTestRecipient>>
  | Awaited<ReturnType<typeof deleteEmailTestRecipient>>
  | { error: { code: string; message: string; details: Record<string, unknown> }; requestId: string };

function errorResult(error: unknown, requestId: string) {
  if (!(error instanceof ResearchApiError)) throw error;
  return {
    terminalStatus: "failed" as const,
    responseStatus: error.status,
    errorCode: error.code,
    response: { error: { code: error.code,message: error.message,details: error.details },requestId },
  };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    const { id: recipientId } = await context.params;
    let command;
    try {
      command = normalizeEmailRecipientCommand(await readResearchJson(request, 2_048));
    } catch (error) {
      const code = error instanceof Error ? error.message : "EMAIL_RECIPIENT_FIELDS_INVALID";
      throw new ResearchApiError(code, "测试收件地址动作或变更原因无效", 422);
    }
    const correlation = maintenanceCorrelation(request);
    const responseRequestId = correlation.requestId ?? crypto.randomUUID();
    const result = await runMaintenanceIdempotentCommand<ItemResponse>(await getPostgresPool(), {
      operation: "maintenance.email_recipient.update",actorUserId: user.id,
      subjectType: "notification_email_test_recipient",subjectId: recipientId,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",payload: command,
      ...correlation,requestId: responseRequestId,
    }, async (client) => {
      try {
        const response = await updateEmailTestRecipient(client, {
          actorUserId: user.id,recipientId,...command,request,
        });
        return { terminalStatus: "succeeded",responseStatus: 200,response } as const;
      } catch (error) { return errorResult(error,responseRequestId); }
    });
    return Response.json(result.response, { status: result.responseStatus,headers: {
      "cache-control": "no-store","idempotency-replayed": String(result.replayed),"x-request-id": responseRequestId,
    } });
  } catch (error) { return researchErrorResponse(error,request); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    const { id: recipientId } = await context.params;
    const body = await readResearchJson(request, 2_048);
    const reason = maintenanceReason(body.reason);
    if (Object.keys(body).length !== 1) throw new ResearchApiError("EMAIL_RECIPIENT_FIELDS_INVALID", "删除请求只允许提交变更原因", 422);
    const correlation = maintenanceCorrelation(request);
    const responseRequestId = correlation.requestId ?? crypto.randomUUID();
    const result = await runMaintenanceIdempotentCommand<ItemResponse>(await getPostgresPool(), {
      operation: "maintenance.email_recipient.delete",actorUserId: user.id,
      subjectType: "notification_email_test_recipient",subjectId: recipientId,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",payload: { reason },
      ...correlation,requestId: responseRequestId,
    }, async (client) => {
      try {
        const response = await deleteEmailTestRecipient(client, { actorUserId: user.id,recipientId,reason,request });
        return { terminalStatus: "succeeded",responseStatus: 200,response } as const;
      } catch (error) { return errorResult(error,responseRequestId); }
    });
    return Response.json(result.response, { status: result.responseStatus,headers: {
      "cache-control": "no-store","idempotency-replayed": String(result.replayed),"x-request-id": responseRequestId,
    } });
  } catch (error) { return researchErrorResponse(error,request); }
}
