import { requireAccessPermission } from "@/lib/access-control";
import { applyEmailServiceConfiguration } from "@/lib/email-service-management";
import { resolveEmailSecret } from "@/lib/email-secret-broker";
import { maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runMaintenanceIdempotentCommand } from "@/lib/maintenance-idempotency";
import { getPostgresPool } from "@/lib/postgres";
import { normalizeEmailConfigurationCommand } from "@/packages/notifications/src/email-service-management";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    let command;
    try {
      command = normalizeEmailConfigurationCommand(await readResearchJson(request, 2_048));
    } catch (error) {
      const code = error instanceof Error ? error.message : "EMAIL_CONFIGURATION_FIELDS_INVALID";
      throw new ResearchApiError(code, "邮件配置字段、动作或审计原因无效", 422);
    }
    const correlation = maintenanceCorrelation(request);
    const responseRequestId = correlation.requestId ?? crypto.randomUUID();
    type CommandResponse = Awaited<ReturnType<typeof applyEmailServiceConfiguration>> | {
      error: { code: string; message: string; details: Record<string, unknown> };
      requestId: string;
    };
    const result = await runMaintenanceIdempotentCommand<CommandResponse>(await getPostgresPool(), {
      operation: "maintenance.email_configuration.update",
      actorUserId: user.id,
      subjectType: "notification_provider_config",
      subjectId: "resend-email",
      idempotencyKey,
      payload: command,
      ...correlation,
      requestId: responseRequestId,
    }, async (client) => {
      try {
        const webhookSecret = await resolveEmailSecret("maintenance");
        const response = await applyEmailServiceConfiguration(client, {
          actorUserId: user.id,
          ...command,
          request,
          webhookSecretPresent: Boolean(webhookSecret),
        });
        return { terminalStatus: "succeeded", responseStatus: 200, response } as const;
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
