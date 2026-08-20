import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

type LedgerCursor = { createdAt: string; id: string };

function decodeCursor(value: string | null): LedgerCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<LedgerCursor>;
    if (!parsed.createdAt || !parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("invalid cursor");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ResearchApiError("VALIDATION_ERROR", "账本游标无效", 422, { fields: ["cursor"] });
  }
}

function encodeCursor(cursor: LedgerCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.ledger.view");
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
    const params: unknown[] = [];
    const where: string[] = [];
    for (const [queryName, column] of [["type", "lt.transaction_type"], ["currency", "lt.currency"]] as const) {
      const value = url.searchParams.get(queryName)?.trim();
      if (value) {
        params.push(value);
        where.push(`${column} = $${params.length}`);
      }
    }
    for (const [queryName, operator] of [["from", ">="], ["to", "<="]] as const) {
      const value = url.searchParams.get(queryName)?.trim();
      if (!value) continue;
      if (Number.isNaN(Date.parse(value))) throw new ResearchApiError("VALIDATION_ERROR", `${queryName} 时间无效`, 422, { fields: [queryName] });
      params.push(value);
      where.push(`lt.created_at ${operator} $${params.length}::timestamptz`);
    }
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      where.push(`(lt.created_at, lt.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }

    const scoped = customerScopePredicate(
      scope,
      { userId: user.id, organizationId: user.organizationId },
      "scope_ca",
      "scope_account.owner_user_id",
      params.length + 1,
      organizationIds,
    );
    params.push(...scoped.values);
    if (scoped.clause !== "TRUE") {
      where.push(`EXISTS (
        SELECT 1
        FROM ledger_postings AS scope_posting
        INNER JOIN ledger_accounts AS scope_account ON scope_account.id = scope_posting.account_id
        LEFT JOIN customer_attributions AS scope_ca ON scope_ca.customer_id = scope_account.owner_user_id
        WHERE scope_posting.transaction_id = lt.id AND ${scoped.clause}
      )`);
    }
    params.push(limit + 1);
    const pool = await getPostgresPool();
    const transactions = await pool.query<{
      id: string;
      transaction_type: string;
      source_type: string;
      source_id: string;
      currency: string;
      status: string;
      created_by_user_id: string | null;
      created_at: Date;
    }>(`
      SELECT lt.id, lt.transaction_type, lt.source_type, lt.source_id, lt.currency,
             lt.status, lt.created_by_user_id, lt.created_at
      FROM ledger_transactions AS lt
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY lt.created_at DESC, lt.id DESC
      LIMIT $${params.length}
    `, params);

    const hasMore = transactions.rows.length > limit;
    const rows = transactions.rows.slice(0, limit);
    const postings = rows.length ? await pool.query<{
      id: string;
      transaction_id: string;
      account_id: string;
      account_type: string;
      owner_user_id: string | null;
      owner_organization_id: string | null;
      side: string;
      amount: string;
      currency: string;
    }>(`
      SELECT lp.id, lp.transaction_id, lp.account_id, la.account_type,
             la.owner_user_id, la.owner_organization_id, lp.side,
             lp.amount::text, lp.currency
      FROM ledger_postings AS lp
      INNER JOIN ledger_accounts AS la ON la.id = lp.account_id
      WHERE lp.transaction_id = ANY($1::text[])
      ORDER BY lp.created_at, lp.id
    `, [rows.map((row) => row.id)]) : { rows: [] };
    const postingsByTransaction = new Map<string, typeof postings.rows>();
    for (const posting of postings.rows) {
      const list = postingsByTransaction.get(posting.transaction_id) ?? [];
      list.push(posting);
      postingsByTransaction.set(posting.transaction_id, list);
    }
    const last = rows.at(-1);
    return Response.json({
      transactions: rows.map((row) => ({
        id: row.id,
        type: row.transaction_type,
        sourceType: row.source_type,
        sourceId: row.source_id,
        currency: row.currency,
        status: row.status,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at.toISOString(),
        postings: (postingsByTransaction.get(row.id) ?? []).map((posting) => ({
          id: posting.id,
          accountId: posting.account_id,
          accountType: posting.account_type,
          ownerUserId: posting.owner_user_id,
          ownerOrganizationId: posting.owner_organization_id,
          side: posting.side,
          amount: posting.amount,
          currency: posting.currency,
        })),
      })),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
