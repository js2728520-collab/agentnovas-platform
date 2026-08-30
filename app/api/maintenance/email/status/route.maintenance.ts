import { requireAnyAccessPermission } from "@/lib/access-control";
import { loadEmailServiceOverview } from "@/lib/email-service-management";
import { getPostgresPool } from "@/lib/postgres";
import { publicAppOriginForAudience } from "@/lib/riverton-apps";
import { resolveEmailSecret } from "@/lib/email-secret-broker";
import { loadEmailSecretManagementStatus } from "@/lib/email-secret-management";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, access } = await requireAnyAccessPermission(request, [
      "maint.email_integrations.manage",
      "maint.system_health.view",
    ]);
    const pool = await getPostgresPool();
    const [result,secretManagement] = await Promise.all([loadEmailServiceOverview(pool, {
      viewerUserId: user.id,
      viewerEmail: user.email,
      includeTestRecipient: Boolean(access.grants["maint.email_integrations.manage"]),
      webhookSecretPresent: Boolean(await resolveEmailSecret("maintenance")),
    }), access.grants["maint.email_integrations.manage"]
      ? loadEmailSecretManagementStatus(pool)
      : Promise.resolve(null)]);
    const webhookUrl = new URL(
      "/api/integrations/resend/webhook",
      publicAppOriginForAudience("maintenance"),
    ).toString();
    return Response.json({ ...result,webhookUrl,secretManagement }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
