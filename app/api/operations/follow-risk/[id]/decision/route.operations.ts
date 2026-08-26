import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { pauseFollow, resumeFollow, stopFollow } from "@/packages/domain/src/strategy-follow-lifecycle";

const MANAGE_PERMISSION = "ops.follow_risk.manage";

/**
 * 运营风控对单个客户跟随的阻断与恢复（T4.4b / PRD 6.6）。
 *
 * 沿用熔断开关的不对称设计（`execution_kill_switches`）：**挂上单人即时，摘除要第二个人**。
 * 出事的时候没有时间等第二个人签字；而解除阻断是把风险重新打开，不该由同一个人独自完成。
 *
 * 这里的「第二个人」是轻量形式——解除者不能是当初阻断者本人（INV-3 的核心：发起人不能
 * 批准自己发起的单据），不走完整的审批单流程。逐客户的风控操作量级不适合审批队列。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user: actor } = await requireAccessPermission(request, MANAGE_PERMISSION);
    const { id } = await params;
    const body = await readResearchJson(request, 4_096);
    const action = String(body.action ?? "");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!["pause", "resume", "stop"].includes(action)) {
      throw new ResearchApiError("FOLLOW_RISK_ACTION_INVALID", "风控动作无效", 422);
    }
    // 一个没有理由的阻断，事后没人知道能不能摘。
    if (reason.length < 3 || reason.length > 500) {
      throw new ResearchApiError("FOLLOW_RISK_REASON_INVALID", "风控说明需要 3–500 个字符", 422);
    }

    const client = await (await getPostgresPool()).connect();
    try {
      await client.query("BEGIN");
      const subscription = (await client.query<{
        id: string; status: string; paused_by: string | null; customer_id: string;
      }>(
        "SELECT id,status,paused_by,customer_id FROM strategy_subscriptions WHERE id=$1 FOR UPDATE",
        [id],
      )).rows[0];
      if (!subscription) throw new ResearchApiError("FOLLOW_NOT_FOUND", "跟随关系不存在", 404);

      let transition;
      if (action === "pause") {
        transition = pauseFollow(subscription.status, "operations_risk");
      } else if (action === "stop") {
        transition = stopFollow(subscription.status, "operations_risk");
      } else {
        // 解除者不能是当初阻断者本人。解除阻断是把风险重新打开。
        const engager = (await client.query<{ actor_user_id: string | null }>(`
          SELECT actor_user_id FROM strategy_follow_risk_events
           WHERE subscription_id=$1 AND action='pause'
           ORDER BY created_at DESC LIMIT 1
        `, [id])).rows[0];
        if (engager?.actor_user_id && engager.actor_user_id === actor.id) {
          throw new ResearchApiError(
            "MAKER_CHECKER_REQUIRED",
            "解除阻断需要另一位风控人员，不能由当初阻断的人自己解除",
            403,
          );
        }
        transition = resumeFollow(subscription.status, {
          pausedBy: subscription.paused_by, authority: "operations_risk",
        });
      }

      if (!transition.allowed) {
        throw new ResearchApiError(
          transition.reason === "insufficient_authority"
            ? "FOLLOW_RISK_AUTHORITY_INSUFFICIENT"
            : "FOLLOW_TRANSITION_INVALID",
          transition.reason === "insufficient_authority"
            ? "该阻断由更高权威做出，运营风控无法解除"
            : "跟随当前状态不允许该动作",
          409,
          { status: subscription.status, pausedBy: subscription.paused_by },
        );
      }

      const now = new Date();
      await client.query(`
        UPDATE strategy_subscriptions
           SET status=$2,
               paused_by=$3,
               paused_at=CASE WHEN $3::text IS NULL THEN NULL ELSE $6 END,
               paused_reason=CASE WHEN $3::text IS NULL THEN NULL ELSE $4 END,
               ended_by=CASE WHEN $2='stopped' THEN 'operations_risk' ELSE ended_by END,
               ended_reason=CASE WHEN $2='stopped' THEN 'operations_terminated' ELSE ended_reason END,
               ended_at=CASE WHEN $2='stopped' THEN $5 ELSE ended_at END,
               updated_at=$5
         WHERE id=$1
      `, [id, transition.nextState, transition.pausedBy, reason, now.toISOString(), now]);

      await client.query(`
        INSERT INTO strategy_follow_risk_events(id,subscription_id,authority,action,reason,actor_user_id)
        VALUES($1,$2,'operations_risk',$3,$4,$5)
      `, [crypto.randomUUID(), id, action, reason, actor.id]);

      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
        VALUES($1,$2,$3,'strategy_subscription',$4,$5,$6,$7)
      `, [
        crypto.randomUUID(), actor.id, `strategy.follow.risk.${action}`, id,
        JSON.stringify({ status: subscription.status, pausedBy: subscription.paused_by }),
        JSON.stringify({ status: transition.nextState, reason, actorId: actor.id }),
        now,
      ]);
      await client.query("COMMIT");
      return Response.json({ status: transition.nextState, pausedBy: transition.pausedBy }, {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
