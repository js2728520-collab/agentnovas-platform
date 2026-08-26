import { requireAccessPermission } from "@/lib/access-control";
import { commercialCustomerScopePredicate } from "@/lib/commercial-operations-scope";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.view");
    const scoped = commercialCustomerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "scope_data", "customer.id", 1, organizationIds);
    const values = [...scoped.values];
    const visible = `WITH visible_customers AS (
      SELECT customer.id,customer.created_at
        FROM users customer
       WHERE customer.role='customer' AND ${scoped.clause}
    )`;
    const pool = await getPostgresPool();
    const [summary, trend, strategies, queue] = await Promise.all([
      pool.query(`${visible}
        SELECT
          (SELECT count(*) FROM visible_customers)::text AS customers,
          (SELECT count(*) FROM memberships membership JOIN visible_customers customer ON customer.id=membership.customer_id WHERE membership.status='active' AND (membership.expires_at IS NULL OR membership.expires_at::timestamptz>now()))::text AS active_memberships,
          (SELECT count(*) FROM commercial_membership_orders orders JOIN visible_customers customer ON customer.id=orders.user_id WHERE orders.status='activated')::text AS activated_orders,
          (SELECT count(*) FROM commercial_membership_orders orders JOIN visible_customers customer ON customer.id=orders.user_id WHERE orders.status='pending_review')::text AS pending_membership_orders,
          (SELECT COALESCE(sum(account.available_credits),0)::text FROM ai_credit_accounts account JOIN visible_customers customer ON customer.id=account.user_id) AS available_credits,
          (SELECT count(*) FROM official_paper_portfolios portfolio JOIN visible_customers customer ON customer.id=portfolio.customer_id)::text AS paper_portfolios,
          (SELECT count(*) FROM official_paper_positions position JOIN official_paper_portfolios portfolio ON portfolio.id=position.portfolio_id JOIN visible_customers customer ON customer.id=portfolio.customer_id WHERE position.status='open')::text AS open_positions,
          (SELECT COALESCE(sum(portfolio.realized_net_pnl_usdt),0)::text FROM official_paper_portfolios portfolio JOIN visible_customers customer ON customer.id=portfolio.customer_id) AS realized_net_pnl,
          (SELECT COALESCE(sum(statement.fee_amount),0)::text FROM performance_fee_statements statement JOIN visible_customers customer ON customer.id=statement.user_id WHERE statement.status IN('pending_review','approved','payment_pending')) AS outstanding_performance_fees
      `, values),
      pool.query(`${visible}, months AS (
          SELECT generate_series(date_trunc('month',now())-interval '5 months',date_trunc('month',now()),interval '1 month') AS month
        )
        SELECT to_char(months.month,'YYYY-MM') AS month,
               (SELECT count(*) FROM visible_customers customer WHERE customer.created_at::timestamptz>=months.month AND customer.created_at::timestamptz<months.month+interval '1 month')::text AS registered_customers,
               (SELECT count(*) FROM commercial_membership_orders orders JOIN visible_customers customer ON customer.id=orders.user_id WHERE orders.status='activated' AND orders.activated_at>=months.month AND orders.activated_at<months.month+interval '1 month')::text AS activated_orders,
               (SELECT count(*) FROM official_paper_fill_receipts receipt JOIN official_paper_portfolios portfolio ON portfolio.id=receipt.portfolio_id JOIN visible_customers customer ON customer.id=portfolio.customer_id WHERE receipt.filled_at>=months.month AND receipt.filled_at<months.month+interval '1 month')::text AS paper_fills,
               (SELECT COALESCE(sum(receipt.realized_net_pnl_usdt),0)::text FROM official_paper_fill_receipts receipt JOIN official_paper_portfolios portfolio ON portfolio.id=receipt.portfolio_id JOIN visible_customers customer ON customer.id=portfolio.customer_id WHERE receipt.filled_at>=months.month AND receipt.filled_at<months.month+interval '1 month') AS realized_net_pnl
          FROM months ORDER BY months.month
      `, values),
      pool.query(`${visible}
        SELECT portfolio.strategy_code,
               count(*)::text AS portfolios,
               count(*) FILTER(WHERE portfolio.access_status='active')::text AS active_portfolios,
               COALESCE(sum(portfolio.realized_net_pnl_usdt),0)::text AS realized_net_pnl,
               COALESCE(sum(portfolio.fees_usdt),0)::text AS paper_fees
          FROM official_paper_portfolios portfolio
          JOIN visible_customers customer ON customer.id=portfolio.customer_id
         GROUP BY portfolio.strategy_code ORDER BY portfolio.strategy_code
      `, values),
      pool.query(`${visible}
        SELECT
          (SELECT count(*) FROM ai_credit_adjustment_requests request JOIN visible_customers customer ON customer.id=request.user_id WHERE request.status='pending')::text AS credit_adjustments,
          (SELECT count(*) FROM customer_attribution_change_requests request JOIN visible_customers customer ON customer.id=request.customer_id WHERE request.status='pending')::text AS attribution_changes,
          (SELECT count(*) FROM performance_fee_statements statement JOIN visible_customers customer ON customer.id=statement.user_id WHERE statement.status='pending_review')::text AS performance_reviews
      `, values),
    ]);
    const row = summary.rows[0];
    return Response.json({
      summary: {
        customers: row.customers, activeMemberships: row.active_memberships, activatedOrders: row.activated_orders,
        pendingMembershipOrders: row.pending_membership_orders, availableCredits: row.available_credits,
        paperPortfolios: row.paper_portfolios, openPositions: row.open_positions,
        realizedNetPnl: row.realized_net_pnl, outstandingPerformanceFees: row.outstanding_performance_fees,
      },
      trend: trend.rows.map((item) => ({ month: item.month, registeredCustomers: item.registered_customers, activatedOrders: item.activated_orders, paperFills: item.paper_fills, realizedNetPnl: item.realized_net_pnl })),
      strategies: strategies.rows.map((item) => ({ strategyCode: item.strategy_code, portfolios: item.portfolios, activePortfolios: item.active_portfolios, realizedNetPnl: item.realized_net_pnl, paperFees: item.paper_fees })),
      pendingQueue: { creditAdjustments: queue.rows[0].credit_adjustments, attributionChanges: queue.rows[0].attribution_changes, performanceReviews: queue.rows[0].performance_reviews },
      scope: { grant: scope, organizationIds },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
