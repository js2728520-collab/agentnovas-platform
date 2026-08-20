import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate, maskOperationsEmail } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.ledger.view");
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "ca", "cc.customer_id", 1, organizationIds);
    const pool = await getPostgresPool();
    const result = await pool.query(`
      SELECT DISTINCT cc.id, cc.customer_id, u.email, cc.settlement_id, s.amount_usdt,
             cc.due_at, cc.grace_ends_at, cc.status, cc.new_entries_allowed, cc.reminders_sent
      FROM collection_cases AS cc
      INNER JOIN users AS u ON u.id = cc.customer_id
      INNER JOIN settlements AS s ON s.id = cc.settlement_id
      LEFT JOIN customer_attributions AS ca ON ca.customer_id = cc.customer_id AND ca.status = 'active'
      WHERE ${scoped.clause}
      ORDER BY cc.due_at DESC
      LIMIT 300
    `, scoped.values);
    return Response.json({ collections: result.rows.map((row) => ({
      id: row.id, customerId: row.customer_id, email: maskOperationsEmail(row.email), settlementId: row.settlement_id,
      amountUsdt: row.amount_usdt, dueAt: row.due_at, graceEndsAt: row.grace_ends_at,
      status: row.status, newEntriesAllowed: Boolean(row.new_entries_allowed), remindersSent: row.reminders_sent,
    })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error); }
}
