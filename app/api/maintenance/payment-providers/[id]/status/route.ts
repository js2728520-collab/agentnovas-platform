import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const statuses = new Set(["sandbox", "active", "disabled"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const status = String(body.status ?? "");
    if (!statuses.has(status)) throw new ResearchApiError("VALIDATION_ERROR", "支付渠道状态无效", 422, { fields: ["status"] });
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写支付渠道变更原因", 422, { fields: ["reason"] });
    const pool = await getPostgresPool();
    const client = await pool.connect();
    let changed = false;
    try {
      await client.query("BEGIN");
      const result = await client.query("UPDATE payment_provider_configs SET status = $1, updated_by_user_id = $2, updated_at = now() WHERE id = $3 RETURNING id", [status, user.id, id]);
      changed = Boolean(result.rows[0]);
      if (changed) await client.query(`INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json) VALUES ($1, $2, 'payment_provider.status_changed', 'payment_provider_config', $3, $4)`, [crypto.randomUUID(), user.id, id, JSON.stringify({ status, reason })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!changed) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
    return Response.json({ ok: true, id, status });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
