import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const body = await readResearchJson(request);
    const action = String(body.action ?? "");
    if (action !== "pause" && action !== "stop") {
      throw new ResearchApiError("VALIDATION_ERROR", "操作类型必须是 pause 或 stop", 422, { fields: ["action"] });
    }
    const pool = await getPostgresPool();
    const direct = (await pool.query<{ id: string }>(`
      SELECT id FROM strategy_subscriptions WHERE id = $1 AND customer_id = $2 LIMIT 1
    `, [id, user.id])).rows[0];
    const migrated = direct ? null : (await pool.query<{ strategy_subscription_id: string }>(`
        SELECT migration.strategy_subscription_id
        FROM platform_subscription_migrations AS migration
        JOIN strategy_subscriptions AS subscription ON subscription.id = migration.strategy_subscription_id
        WHERE migration.legacy_subscription_id = $1 AND subscription.customer_id = $2
        LIMIT 1
      `, [id, user.id])).rows[0];
    const subscriptionId = direct?.id ?? migrated?.strategy_subscription_id;
    if (!subscriptionId) throw new ResearchApiError("SUBSCRIPTION_NOT_FOUND", "平台策略订阅不存在", 404);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (action === "stop") {
        const open = Number((await client.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM strategy_paper_positions AS position
          JOIN strategy_deployments AS deployment ON deployment.id = position.deployment_id
          WHERE deployment.strategy_subscription_id = $1 AND position.status = 'open'
        `, [subscriptionId])).rows[0]?.count || 0);
        if (open > 0) throw new ResearchApiError("OPEN_POSITION_EXISTS", "仍有模拟持仓，必须先由策略退出或执行紧急平仓流程", 409);
      }
      const status = action === "pause" ? "paused" : "ended";
      await client.query(`
        UPDATE strategy_subscriptions
        SET status = $2, runtime_status = $2,
            ended_at = CASE WHEN $2 = 'ended' THEN $3 ELSE ended_at END,
            updated_at = $3
        WHERE id = $1 AND customer_id = $4
      `, [subscriptionId, status, new Date().toISOString(), user.id]);
      await client.query(`
        UPDATE strategy_deployments
        SET status = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE strategy_subscription_id = $1 AND owner_user_id = $3
          AND status IN ('active', 'paused')
      `, [subscriptionId, status, user.id]);
      await client.query("COMMIT");
      return Response.json({ id: subscriptionId, status, message: status === "ended" ? "模拟策略运行已停止" : "策略已暂停，不再处理新 K 线" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error);
  }
}
