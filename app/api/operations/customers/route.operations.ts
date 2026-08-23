import { requireAccessPermission } from "@/lib/access-control";
import { commercialListInput } from "@/lib/commercial-api";
import { encodeCommercialCursor } from "@/lib/commercial-api-support";
import {
  availableCustomerPiiCategories,
  CUSTOMER_PII_PERMISSION_KEYS,
  customerPiiAccessRequest,
  projectOperationsCustomerPii,
  restrictCustomerPiiScope,
} from "@/lib/operations-customer-pii";
import {
  loadOperationsCustomerPii,
  operationsCustomerPiiOrEmpty,
  recordOperationsCustomerPiiAudit,
} from "@/lib/operations-customer-pii-service";
import { operationsCustomerFilter } from "@/lib/operations-customer-query";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, access, scope, organizationIds } = await requireAccessPermission(request, "ops.customers.view");
    const { limit, cursor } = commercialListInput(request);
    const piiAccess = customerPiiAccessRequest(request, access.permissions);
    await Promise.all(piiAccess.categories.map((category) => requireAccessPermission(request, CUSTOMER_PII_PERMISSION_KEYS[category])));
    const effectiveScope = piiAccess.categories.length ? restrictCustomerPiiScope({
      base: { scope, organizationIds }, categories: piiAccess.categories, grants: access.grants,
      identityOrganizationId: user.organizationId,
    }) : { scope, organizationIds };
    const filter = operationsCustomerFilter(
      request,
      effectiveScope.scope,
      { userId: user.id, organizationId: user.organizationId },
      effectiveScope.organizationIds,
      piiAccess.categories.includes("contact"),
    );
    const baseValues = filter.values;
    const baseWhere = filter.where;
    const pool = await getPostgresPool();
    const count = await pool.query(`SELECT count(*)::text AS total FROM users customer LEFT JOIN customer_profiles profile ON profile.customer_id=customer.id WHERE ${baseWhere.join(" AND ")}`, baseValues);
    const values = [...baseValues];
    const where = [...baseWhere];
    if (cursor) { values.push(cursor.createdAt, cursor.id); where.push(`(customer.created_at,customer.id)<($${values.length - 1}::timestamptz,$${values.length})`); }
    values.push(limit + 1);
    const result = await pool.query(`
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
    const piiRows = await loadOperationsCustomerPii(pool, rows.map((row) => row.id));
    const last = rows.at(-1);
    const customers = rows.map((row) => {
      const pii = projectOperationsCustomerPii(operationsCustomerPiiOrEmpty(piiRows, row.id), piiAccess.categories);
      return {
        customerId: row.id, email: pii.contact.email ?? "***", status: row.status,
        registeredAt: new Date(row.created_at).toISOString(), displayName: row.display_name || null,
        contactNote: row.contact_note || null, branchId: row.branch_id, managerId: row.manager_id,
        supervisorId: row.supervisor_id, employeeId: row.employee_id, pii,
      };
    });
    if (piiAccess.categories.length) {
      await recordOperationsCustomerPiiAudit(pool, {
        actorUserId: user.id, action: "customer.pii_viewed", subjectType: "customer_collection",
        subjectId: `scope:${effectiveScope.scope}`, categories: piiAccess.categories, reason: piiAccess.reason!, scope: effectiveScope.scope,
        organizationIds: effectiveScope.organizationIds, resultCount: customers.length, requestId: request.headers.get("x-request-id"),
      });
    }
    return Response.json({
      customers,
      total: count.rows[0]?.total ?? "0",
      canManage: Boolean(access.permissions["ops.customers.manage"]),
      canExport: Boolean(access.permissions["ops.customers.export"]),
      piiAccess: { available: availableCustomerPiiCategories(access.permissions), revealed: piiAccess.categories },
      page: {
        limit,
        nextCursor: result.rows.length > limit && last ? encodeCommercialCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id }) : null,
        hasMore: result.rows.length > limit,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}
