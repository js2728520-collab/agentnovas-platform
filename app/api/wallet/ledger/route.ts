import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.wallet.view");
    const pool = await getPostgresPool();
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
    const result = await pool.query<{
      id: string;
      transaction_type: string;
      source_type: string;
      source_id: string;
      currency: string;
      created_at: Date;
      amount: string;
    }>(`
      SELECT lt.id, lt.transaction_type, lt.source_type, lt.source_id, lt.currency, lt.created_at,
             SUM(CASE WHEN lp.side = 'credit' THEN lp.amount ELSE -lp.amount END)::text AS amount
      FROM ledger_transactions AS lt
      INNER JOIN ledger_postings AS lp ON lp.transaction_id = lt.id
      INNER JOIN ledger_accounts AS la ON la.id = lp.account_id
      WHERE la.owner_user_id = $1
      GROUP BY lt.id
      ORDER BY lt.created_at DESC
      LIMIT $2
    `, [user.id, limit]);
    return Response.json({
      entries: result.rows.map((row) => ({
        id: row.id,
        type: row.transaction_type,
        sourceType: row.source_type,
        sourceId: row.source_id,
        currency: row.currency,
        amount: row.amount,
        createdAt: row.created_at.toISOString(),
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

