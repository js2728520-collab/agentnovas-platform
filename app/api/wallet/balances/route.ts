import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "client.wallet.view");
    const pool = await getPostgresPool();
    const result = await pool.query<{
      currency: string;
      available_amount: string;
      frozen_amount: string;
      version: string;
      updated_at: Date;
    }>(`
      SELECT currency, available_amount::text, frozen_amount::text, version::text, updated_at
      FROM wallet_balances
      WHERE user_id = $1
      ORDER BY currency ASC
    `, [user.id]);
    return Response.json({
      balances: result.rows.map((row) => ({
        currency: row.currency,
        availableAmount: row.available_amount,
        frozenAmount: row.frozen_amount,
        version: row.version,
        updatedAt: row.updated_at.toISOString(),
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

