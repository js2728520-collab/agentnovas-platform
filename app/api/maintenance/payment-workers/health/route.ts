import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.system_health.view");
    const pool = await getPostgresPool();
    await pool.query("SELECT 1");
    return Response.json({
      paymentWorker: {
        enabled: process.env.PAYMENT_WORKER_ENABLED === "true",
        configured: Boolean(process.env.DATABASE_URL?.trim()),
      },
      notificationWorker: {
        enabled: process.env.NOTIFICATION_WORKER_ENABLED === "true",
        resendConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

