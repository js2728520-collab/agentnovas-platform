import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { requireUser } from "@/lib/session";

/**
 * 客户自己的跟单与模拟盘结果（T4.4）。
 *
 * 只返回**本人**的跟随。作者是谁、其他跟随者是谁都不返回——客户看自己的结果不需要知道
 * 这些，而多返回一个字段就多一条泄露路径。
 */
export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const me = await requireUser(request, ["customer"]);
    const pool = await getPostgresPool();
    const follows = await pool.query(`
      SELECT subscription.id,
             subscription.status,
             subscription.paused_by,
             subscription.paused_reason,
             subscription.run_mode,
             subscription.capital_pct,
             subscription.stop_loss_pct,
             subscription.started_at,
             strategy.name AS strategy_name,
             strategy.status AS listing_status,
             portfolio.id AS portfolio_id,
             portfolio.principal_usdt::text AS principal_usdt,
             portfolio.cash_usdt::text AS cash_usdt,
             portfolio.realized_net_pnl_usdt::text AS realized_net_pnl_usdt,
             portfolio.fees_usdt::text AS fees_usdt,
             contract.performance_fee_bps,
             contract.confirmed_at
        FROM strategy_subscriptions AS subscription
        JOIN community_strategies AS strategy ON strategy.id = subscription.strategy_id
        LEFT JOIN strategy_follow_paper_portfolios AS portfolio
          ON portfolio.subscription_id = subscription.id
        LEFT JOIN strategy_follow_contracts AS contract
          ON contract.subscription_id = subscription.id
       WHERE subscription.customer_id = $1
       ORDER BY subscription.status <> 'stopped' DESC, subscription.started_at DESC NULLS LAST
       LIMIT 50
    `, [me.id]);

    const portfolioIds = follows.rows.map((row) => row.portfolio_id).filter(Boolean);
    const positions = portfolioIds.length
      ? (await pool.query(`
          SELECT portfolio_id, symbol, quantity::text, average_entry_price::text, cost_basis_usdt::text
            FROM strategy_follow_paper_positions
           WHERE portfolio_id = ANY($1::text[]) AND status = 'open'
           ORDER BY opened_at
        `, [portfolioIds])).rows
      : [];
    const fills = portfolioIds.length
      ? (await pool.query(`
          SELECT portfolio_id, symbol, action, quantity::text, fill_price::text,
                 fee_usdt::text, realized_net_pnl_usdt::text, filled_at
            FROM strategy_follow_paper_fill_receipts
           WHERE portfolio_id = ANY($1::text[])
           ORDER BY filled_at DESC, id DESC
           LIMIT 200
        `, [portfolioIds])).rows
      : [];

    return Response.json({
      follows: follows.rows.map((row) => ({
        subscriptionId: row.id,
        status: row.status,
        pausedBy: row.paused_by,
        pausedReason: row.paused_reason,
        runMode: row.run_mode,
        capitalPct: Number(row.capital_pct),
        stopLossPct: Number(row.stop_loss_pct),
        startedAt: row.started_at,
        strategyName: row.strategy_name,
        listingStatus: row.listing_status,
        confirmedAt: row.confirmed_at,
        performanceFeeBps: row.performance_fee_bps,
        portfolio: row.portfolio_id ? {
          principalUsdt: row.principal_usdt,
          cashUsdt: row.cash_usdt,
          realizedNetPnlUsdt: row.realized_net_pnl_usdt,
          feesUsdt: row.fees_usdt,
          positions: positions.filter((position) => position.portfolio_id === row.portfolio_id).map((position) => ({
            symbol: position.symbol,
            quantity: position.quantity,
            averageEntryPrice: position.average_entry_price,
            costBasisUsdt: position.cost_basis_usdt,
          })),
          fills: fills.filter((fill) => fill.portfolio_id === row.portfolio_id).map((fill) => ({
            symbol: fill.symbol,
            action: fill.action,
            quantity: fill.quantity,
            fillPrice: fill.fill_price,
            feeUsdt: fill.fee_usdt,
            realizedNetPnlUsdt: fill.realized_net_pnl_usdt,
            filledAt: fill.filled_at,
          })),
        } : null,
      })),
      // paper 不收费（P-06）。界面要说清这一点，否则客户看到费率会以为在扣钱。
      paperChargesFees: false,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
