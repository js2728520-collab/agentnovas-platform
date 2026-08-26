import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { applyStrategyListingTransition, type StrategyListingTransition } from "@/packages/domain/src/strategy-listing-state";
import { isPlatformRiskDelist } from "@/packages/domain/src/strategy-follow-risk";

const REVIEW_PERMISSION = "ops.strategy_listing.review";

/** 运营端可以驱动的迁移。作者侧的 submit / revise 不在这里。 */
const OPERATIONS_TRANSITIONS: Record<string, StrategyListingTransition> = {
  claim: "claim_review",
  approve: "approve",
  reject: "reject",
  list: "list",
  delist: "delist",
};

/**
 * 策略上架审核决定（T4.2）。
 *
 * 这条路径此前**根本不存在**：投稿会创建一张 `strategy_listing` 审批单，而唯一的审批
 * 端点明确拒绝该类型，于是提交后没有任何办法让策略走到已上架。整个策略广场因此从未跑通。
 *
 * 审核与上架是两个动作（PRD 6.5 的状态流里 APPROVED 与 LISTED 各自成态）：通过审核不等于
 * 立刻对外可见。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user: actor } = await requireAccessPermission(request, REVIEW_PERMISSION);
    const { id } = await params;
    const body = await readResearchJson(request, 4_096);
    const action = String(body.action ?? "");
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const transition = OPERATIONS_TRANSITIONS[action];
    if (!transition) throw new ResearchApiError("STRATEGY_REVIEW_ACTION_INVALID", "审核动作无效", 422);
    // 下架必须说明原因：作者主动下架与平台因风险下架对存量跟随者的处理完全相反
    // （需求方确认）。合并成一个「下架」动作会让其中一种处理错。
    const delistReason = transition === "delist" ? String(body.delistReason ?? "") : null;
    if (transition === "delist"
      && !["author_request", "inactivity", "platform_risk", "platform_compliance"].includes(delistReason ?? "")) {
      throw new ResearchApiError("STRATEGY_DELIST_REASON_INVALID", "下架原因无效", 422);
    }
    if (note.length < 3 || note.length > 500) {
      throw new ResearchApiError("STRATEGY_REVIEW_NOTE_INVALID", "审核说明需要 3–500 个字符", 422);
    }

    const client = await (await getPostgresPool()).connect();
    try {
      await client.query("BEGIN");
      const strategy = (await client.query<{
        id: string; status: string; author_user_id: string; version: number; review_claimed_by: string | null;
      }>(
        "SELECT id,status,author_user_id,version,review_claimed_by FROM community_strategies WHERE id=$1 FOR UPDATE",
        [id],
      )).rows[0];
      if (!strategy) throw new ResearchApiError("STRATEGY_NOT_FOUND", "策略不存在", 404);

      // INV-3：审核禁止自审。作者即便同时持有运营审核权限，也不能放行自己的策略。
      if (strategy.author_user_id === actor.id) {
        throw new ResearchApiError("MAKER_CHECKER_REQUIRED", "作者不能审核自己的策略", 403);
      }
      // 认领之后由认领人决定。换人要先重新认领，避免两个人对同一策略各做一半。
      if (strategy.status === "under_review"
        && strategy.review_claimed_by
        && strategy.review_claimed_by !== actor.id
        && action !== "claim") {
        throw new ResearchApiError("STRATEGY_REVIEW_CLAIMED_BY_OTHER", "该策略已由其他审核人认领", 409);
      }

      const applied = applyStrategyListingTransition(strategy.status, transition);
      if (!applied.allowed) {
        throw new ResearchApiError(
          "STRATEGY_LISTING_TRANSITION_INVALID",
          "策略当前状态不允许该动作",
          409,
          { currentStatus: strategy.status, allowedTransitions: applied.allowedTransitions },
        );
      }

      // 未达门槛的策略不得被批准上架。判定在投稿时已经落库，这里重新核对——门槛判定与
      // 审批之间可能隔了很久，而「审核人点了通过」不能成为绕过客观门槛的路径。
      if (transition === "approve" || transition === "list") {
        const admission = (await client.query<{ meets_thresholds: boolean }>(
          "SELECT meets_thresholds FROM strategy_admission_evaluations WHERE strategy_id=$1 AND strategy_version=$2",
          [id, strategy.version],
        )).rows[0];
        if (!admission) {
          throw new ResearchApiError("STRATEGY_ADMISSION_MISSING", "该策略版本没有准入判定记录", 409);
        }
        if (!admission.meets_thresholds) {
          throw new ResearchApiError("STRATEGY_ADMISSION_NOT_MET", "该策略版本未达到准入门槛，不能通过或上架", 409);
        }
      }

      const now = new Date();
      const claimedBy = transition === "claim_review" ? actor.id : strategy.review_claimed_by;
      await client.query(`
        UPDATE community_strategies
           SET status=$2,
               review_claimed_by=$3,
               review_claimed_at=CASE WHEN $4 THEN $6 ELSE review_claimed_at END,
               listed_at=CASE WHEN $2='listed' THEN $6 ELSE listed_at END,
               delisted_at=CASE WHEN $2='delisted' THEN $6 ELSE delisted_at END,
               delist_reason=CASE WHEN $2='delisted' THEN $7 ELSE NULL END,
               rejection_reason=CASE WHEN $2='rejected' THEN $5 ELSE rejection_reason END,
               approved_at=CASE WHEN $2='approved' THEN to_char($6 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE approved_at END,
               published_at=CASE WHEN $2='listed' THEN to_char($6 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE published_at END,
               updated_at=to_char($6 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         WHERE id=$1
      `, [id, applied.nextState, claimedBy, transition === "claim_review", note, now, delistReason]);

      // 平台因风险或合规下架：自动阻断全部存量跟随（需求方确认）。作者主动下架与自动
      // 下架不在此列——它们走 7 天通知缓冲期，客户的跟随不受影响。
      if (applied.nextState === "delisted" && isPlatformRiskDelist(delistReason)) {
        const blocked = await client.query<{ id: string }>(`
          UPDATE strategy_subscriptions
             SET status='risk_blocked', paused_by='operations_risk', paused_at=$2,
                 paused_reason=$3, updated_at=$2
           WHERE strategy_id=$1 AND status IN ('configuring','user_confirmed','active','paused')
          RETURNING id
        `, [id, now, `策略因${delistReason === "platform_risk" ? "风险" : "合规"}原因下架：${note}`]);
        for (const row of blocked.rows) {
          await client.query(`
            INSERT INTO strategy_follow_risk_events(id,subscription_id,authority,action,reason,triggered_rules_json)
            VALUES($1,$2,'operations_risk','pause',$3,$4::jsonb)
          `, [crypto.randomUUID(), row.id, `策略下架：${delistReason}`, JSON.stringify(["platform_risk_delisting"])]);
        }
      }

      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
        VALUES($1,$2,$3,'community_strategy',$4,$5,$6,$7)
      `, [
        crypto.randomUUID(), actor.id, `strategy.listing.${action}`, id,
        JSON.stringify({ status: strategy.status, version: strategy.version }),
        JSON.stringify({ status: applied.nextState, note, reviewerId: actor.id }),
        now,
      ]);
      await client.query("COMMIT");
      return Response.json({ status: applied.nextState, reviewerId: actor.id }, {
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
