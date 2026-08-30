import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.deposits.view");
    const pool = await getPostgresPool();
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "deposit_orders", "deposit_orders.user_id", 1, organizationIds);
    const params: unknown[] = [...scoped.values];
    const where = [scoped.clause];
    const result = await pool.query<{
      total_orders: string;
      credited_orders: string;
      total_credited: string | null;
      total_fees: string | null;
      review_orders: string;
      failed_orders: string;
    }>(`
      SELECT COUNT(*)::text AS total_orders,
             COUNT(*) FILTER (WHERE order_status = 'CREDITED')::text AS credited_orders,
             COALESCE(SUM(credited_amount), 0)::text AS total_credited,
             COALESCE(SUM(fee_amount), 0)::text AS total_fees,
             COUNT(*) FILTER (WHERE order_status = 'MANUAL_REVIEW')::text AS review_orders,
             COUNT(*) FILTER (WHERE order_status IN ('ADDRESS_UNKNOWN','ADDRESS_FAILED','FAILED'))::text AS failed_orders
      FROM deposit_orders
      WHERE ${where.join(" AND ")}
    `, params);
    const byChannel = await pool.query<{
      channel: string;
      currency: string;
      total_amount: string;
      orders: string;
    }>(`
      SELECT channel, currency, COALESCE(SUM(credited_amount), 0)::text AS total_amount, COUNT(*)::text AS orders
      FROM deposit_orders
      WHERE ${where.join(" AND ")}
      GROUP BY channel, currency
      ORDER BY channel ASC, currency ASC
    `, params);
    return Response.json({
      summary: {
        totalOrders: result.rows[0]?.total_orders ?? "0",
        creditedOrders: result.rows[0]?.credited_orders ?? "0",
        totalCredited: result.rows[0]?.total_credited ?? "0",
        totalFees: result.rows[0]?.total_fees ?? "0",
        reviewOrders: result.rows[0]?.review_orders ?? "0",
        failedOrders: result.rows[0]?.failed_orders ?? "0",
      },
      byChannel: byChannel.rows.map((row) => ({
        channel: row.channel,
        currency: row.currency,
        totalAmount: row.total_amount,
        orders: row.orders,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
