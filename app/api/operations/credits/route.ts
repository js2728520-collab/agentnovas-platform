import { requireAccessPermission } from "@/lib/access-control";
import { commercialListInput } from "@/lib/commercial-api";
import { encodeCommercialCursor } from "@/lib/commercial-api-support";
import { commercialCustomerScopePredicate } from "@/lib/commercial-operations-scope";
import { cursorPage } from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(
      request,
      "ops.credits.view",
    );
    const { url, limit, cursor } = commercialListInput(request);
    const values: unknown[] = [];
    const where = ["u.role='customer'"];
    const customerId = url.searchParams.get("customerId")?.trim();
    if (customerId) {
      values.push(customerId);
      where.push(`u.id=$${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where.push(
        `(COALESCE(a.updated_at,u.created_at),u.id)<($${values.length - 1}::timestamptz,$${values.length})`,
      );
    }
    const scoped = commercialCustomerScopePredicate(
      scope,
      { userId: user.id, organizationId: user.organizationId },
      "scope_credit",
      "u.id",
      values.length + 1,
      organizationIds,
    );
    values.push(...scoped.values);
    where.push(scoped.clause);
    values.push(limit + 1);
    const result = await (await getPostgresPool()).query(
      `SELECT u.id AS customer_id,a.id AS account_id,
              COALESCE(a.available_credits,0)::text AS available,
              COALESCE(a.reserved_credits,0)::text AS reserved,
              COALESCE(a.version,0)::text AS version,
              COALESCE(a.updated_at,u.created_at) AS sort_time
       FROM users u
       LEFT JOIN ai_credit_accounts a ON a.user_id=u.id
       WHERE ${where.join(" AND ")}
       ORDER BY sort_time DESC,u.id DESC
       LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor =
      result.rows.length > limit && last
        ? encodeCommercialCursor({
            createdAt: new Date(last.sort_time).toISOString(),
            id: String(last.customer_id),
          })
        : null;
    return Response.json(
      cursorPage(
        rows.map((row) => ({
          customerId: String(row.customer_id),
          accountStatus: row.account_id ? "ACTIVE" : "NOT_OPENED",
          available: String(row.available),
          reserved: String(row.reserved),
          version: String(row.version),
          updatedAt: new Date(row.sort_time).toISOString(),
        })),
        limit,
        nextCursor,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
