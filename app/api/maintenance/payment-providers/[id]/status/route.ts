import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const statuses = new Set(["sandbox", "active", "disabled"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const status = String(body.status ?? "");
    if (!statuses.has(status)) throw new ResearchApiError("VALIDATION_ERROR", "支付渠道状态无效", 422, { fields: ["status"] });
    const pool = await getPostgresPool();
    const result = await pool.query("UPDATE payment_provider_configs SET status = $1, updated_at = now() WHERE id = $2 RETURNING id", [status, id]);
    if (!result.rows[0]) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
    return Response.json({ ok: true, id, status });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
