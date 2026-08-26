import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

const VIEW_PERMISSION = "ops.follow_risk.view";

/**
 * 跟单风控总览（T4.4b）。
 *
 * 只返回运营处理风控需要的字段。**不返回策略规格与客户联系方式**——审核一个跟单是否该被
 * 阻断，不需要知道客户是谁、也不需要看策略代码。
 */
export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, VIEW_PERMISSION);
    const pool = await getPostgresPool();
    const rows = await pool.query(`
      SELECT subscription.id,
             subscription.status,
             subscription.paused_by,
             subscription.paused_at,
             subscription.paused_reason,
             subscription.run_mode,
             subscription.capital_pct,
             subscription.stop_loss_pct,
             strategy.id AS strategy_id,
             strategy.name AS strategy_name,
             strategy.status AS listing_status,
             strategy.delist_reason,
             portfolio.principal_usdt::text AS principal_usdt,
             portfolio.realized_net_pnl_usdt::text AS realized_net_pnl_usdt,
             (SELECT count(*)::int FROM strategy_follow_risk_events AS event
               WHERE event.subscription_id = subscription.id) AS risk_event_count
        FROM strategy_subscriptions AS subscription
        JOIN community_strategies AS strategy ON strategy.id = subscription.strategy_id
        LEFT JOIN strategy_follow_paper_portfolios AS portfolio
          ON portfolio.subscription_id = subscription.id
       WHERE subscription.status <> 'stopped'
       ORDER BY
         -- 被阻断的排最前：那是运营真正要处理的。
         CASE subscription.status WHEN 'risk_blocked' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
         subscription.paused_at DESC NULLS LAST,
         subscription.id
       LIMIT 200
    `);
    return Response.json({
      follows: rows.rows.map((row) => ({
        subscriptionId: row.id,
        status: row.status,
        pausedBy: row.paused_by,
        pausedAt: row.paused_at,
        pausedReason: row.paused_reason,
        runMode: row.run_mode,
        capitalPct: Number(row.capital_pct),
        stopLossPct: Number(row.stop_loss_pct),
        strategyId: row.strategy_id,
        strategyName: row.strategy_name,
        listingStatus: row.listing_status,
        delistReason: row.delist_reason,
        principalUsdt: row.principal_usdt,
        realizedNetPnlUsdt: row.realized_net_pnl_usdt,
        riskEventCount: row.risk_event_count,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
