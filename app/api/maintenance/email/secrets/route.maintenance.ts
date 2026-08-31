import { requireAccessPermission } from "@/lib/access-control";
import { createEmailSecretRequest, loadEmailSecretManagementStatus } from "@/lib/email-secret-management";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { normalizeEmailSecretRequestCommand } from "@/packages/notifications/src/email-service-management";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request,"maint.email_integrations.manage");
    return Response.json(await loadEmailSecretManagementStatus(await getPostgresPool()),{
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) { return researchErrorResponse(error,request); }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request,"maint.email_integrations.manage");
    let command;
    try { command=normalizeEmailSecretRequestCommand(await readResearchJson(request,24_576)); }
    catch (error) {
      const code=error instanceof Error ? error.message : "EMAIL_SECRET_REQUEST_FIELDS_INVALID";
      throw new ResearchApiError(code,"密钥安装或轮换请求无效",422);
    }
    const correlation=maintenanceCorrelation(request);
    const responseRequestId=correlation.requestId ?? crypto.randomUUID();
    type CommandResponse=Awaited<ReturnType<typeof createEmailSecretRequest>>
      | { error: { code: string;message: string;details: Record<string,unknown> };requestId: string };
    const result=await runMaintenanceIdempotentCommand<CommandResponse>(await getPostgresPool(),{
      operation: "maintenance.email_secret.request",actorUserId: user.id,
      subjectType: "notification_email_secret_request",subjectId: command.envelope.keyId,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",payload: command,
      ...correlation,requestId: responseRequestId,
    },async client=>{
      try {
        const response=await createEmailSecretRequest(client,{ actorUserId: user.id,...command,request });
        return { terminalStatus: "succeeded",responseStatus: 202,response } as const;
      } catch (error) {
        if (!(error instanceof ResearchApiError)) throw error;
        return { terminalStatus: "failed",responseStatus: error.status,errorCode: error.code,
          response: { error: { code: error.code,message: error.message,details: error.details },requestId: responseRequestId } } as const;
      }
    });
    return Response.json(result.response,{ status: result.responseStatus,headers: {
      "cache-control": "no-store","idempotency-replayed": String(result.replayed),"x-request-id": responseRequestId,
    } });
  } catch (error) { return researchErrorResponse(error,request); }
}
