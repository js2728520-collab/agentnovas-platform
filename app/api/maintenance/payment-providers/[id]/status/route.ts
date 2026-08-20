import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.payment_integrations.manage");
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const status = String(body.status ?? "");
    if (status !== "disabled") throw new ResearchApiError(
      "BETA_PAYMENT_EXECUTION_DISABLED",
      "本 Beta 仅允许保持或切换为 disabled；sandbox 与 active 未获授权",
      503,
    );
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写支付渠道变更原因", 422, { fields: ["reason"] });
    const pool = await getPostgresPool();
    const client = await pool.connect();
    let changed = false;
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT status FROM payment_provider_configs WHERE id=$1 FOR UPDATE", [id]);
      if (!existing.rows[0]) throw new ResearchApiError("NOT_FOUND", "支付渠道不存在", 404);
      const result = await client.query("UPDATE payment_provider_configs SET status = 'disabled', updated_by_user_id = $1, updated_at = now() WHERE id = $2 AND status IS DISTINCT FROM 'disabled' RETURNING id", [user.id, id]);
      changed = result.rowCount === 1;
      if (changed) await client.query(`INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json) VALUES ($1, $2, 'payment_provider.status_changed', 'payment_provider_config', $3, $4)`, [crypto.randomUUID(), user.id, id, JSON.stringify({ status, reason })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({ ok: true, id, status, result: changed ? "DISABLED" : "NO_CHANGE" });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
