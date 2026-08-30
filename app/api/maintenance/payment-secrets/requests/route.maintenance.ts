import { requireAccessPermission } from "@/lib/access-control";
import { createPaymentSecretRequest } from "@/lib/payment-secret-management";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { normalizePaymentSecretRequestCommand } from "@/packages/payments/src/udun-service-management";

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    let command;
    try { command = normalizePaymentSecretRequestCommand(await readResearchJson(request, 32_768)); }
    catch (error) {
      const code = error instanceof Error ? error.message : "PAYMENT_SECRET_REQUEST_FIELDS_INVALID";
      throw new ResearchApiError(code, "支付配置安装或轮换请求无效", 422);
    }
    const correlation = maintenanceCorrelation(request);
    const responseRequestId = correlation.requestId ?? crypto.randomUUID();
    type CommandResponse = Awaited<ReturnType<typeof createPaymentSecretRequest>>
      | { error: { code: string; message: string; details: Record<string, unknown> }; requestId: string };
    const result = await runMaintenanceIdempotentCommand<CommandResponse>(await getPostgresPool(), {
      operation: "maintenance.payment_secret.request", actorUserId: user.id,
      subjectType: "payment_secret_request", subjectId: command.envelope.keyId,
      idempotencyKey: request.headers.get("idempotency-key") ?? "", payload: command,
      ...correlation, requestId: responseRequestId,
    }, async client => {
      try {
        const response = await createPaymentSecretRequest(client, { actorUserId: user.id, ...command, request });
        return { terminalStatus: "succeeded", responseStatus: 202, response } as const;
      } catch (error) {
        if (!(error instanceof ResearchApiError)) throw error;
        return {
          terminalStatus: "failed", responseStatus: error.status, errorCode: error.code,
          response: { error: { code: error.code, message: error.message, details: error.details }, requestId: responseRequestId },
        } as const;
      }
    });
    return Response.json(result.response, { status: result.responseStatus, headers: {
      "cache-control": "no-store", "idempotency-replayed": String(result.replayed), "x-request-id": responseRequestId,
    } });
  } catch (error) { return researchErrorResponse(error, request); }
}
