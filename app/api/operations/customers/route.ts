import { requireAccessPermission } from "@/lib/access-control";
import { commercialListInput } from "@/lib/commercial-api";
import { encodeCommercialCursor } from "@/lib/commercial-api-support";
import { commercialCustomerScopePredicate } from "@/lib/commercial-operations-scope";
import { maskOperationsEmail } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, access, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.view");
    const { url, limit, cursor } = commercialListInput(request);
    const baseValues: unknown[] = [];
    const baseWhere = ["customer.role='customer'"];
    const status = url.searchParams.get("status")?.trim() ?? "";
    if (status) {
      if (!["active", "pending", "frozen", "closed"].includes(status)) throw new ResearchApiError("CUSTOMER_STATUS_INVALID", "客户状态筛选无效", 422);
      baseValues.push(status); baseWhere.push(`customer.status=$${baseValues.length}`);
    }
    const query = url.searchParams.get("query")?.trim() ?? "";
    if (query.length > 120) throw new ResearchApiError("CUSTOMER_QUERY_INVALID", "客户搜索条件过长", 422);
    if (query) {
      baseValues.push(`%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      baseWhere.push(`(customer.id ILIKE $${baseValues.length} ESCAPE '\\' OR customer.email ILIKE $${baseValues.length} ESCAPE '\\' OR profile.display_name ILIKE $${baseValues.length} ESCAPE '\\')`);
    }
    const scoped = commercialCustomerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "scope_customer_list", "customer.id", baseValues.length + 1, organizationIds);
    baseValues.push(...scoped.values); baseWhere.push(scoped.clause);
    const count = await (await getPostgresPool()).query(`SELECT count(*)::text AS total FROM users customer LEFT JOIN customer_profiles profile ON profile.customer_id=customer.id WHERE ${baseWhere.join(" AND ")}`, baseValues);
    const values = [...baseValues];
    const where = [...baseWhere];
    if (cursor) { values.push(cursor.createdAt, cursor.id); where.push(`(customer.created_at,customer.id)<($${values.length - 1}::timestamptz,$${values.length})`); }
    values.push(limit + 1);
    const result = await (await getPostgresPool()).query(`
      SELECT customer.id,customer.email,customer.status,customer.created_at,
             profile.display_name,profile.contact_note,
             attribution.branch_id,attribution.manager_id,attribution.supervisor_id,attribution.employee_id
        FROM users customer
        LEFT JOIN customer_profiles profile ON profile.customer_id=customer.id
        LEFT JOIN LATERAL (
          SELECT branch_id,manager_id,supervisor_id,employee_id
            FROM customer_attributions WHERE customer_id=customer.id AND status='active'
            ORDER BY effective_at DESC NULLS LAST,created_at DESC LIMIT 1
        ) attribution ON TRUE
       WHERE ${where.join(" AND ")}
       ORDER BY customer.created_at DESC,customer.id DESC LIMIT $${values.length}
    `, values);
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return Response.json({
      customers: rows.map((row) => ({
        customerId: row.id, email: maskOperationsEmail(row.email), status: row.status,
        registeredAt: new Date(row.created_at).toISOString(), displayName: row.display_name || null,
        contactNote: row.contact_note || null, branchId: row.branch_id, managerId: row.manager_id,
        supervisorId: row.supervisor_id, employeeId: row.employee_id,
      })),
      total: count.rows[0]?.total ?? "0",
      canManage: Boolean(access.permissions["ops.customers.manage"]),
      page: {
        limit,
        nextCursor: result.rows.length > limit && last ? encodeCommercialCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id }) : null,
        hasMore: result.rows.length > limit,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
