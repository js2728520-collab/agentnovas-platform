import { requireAccessPermission } from "@/lib/access-control";
import {
  CUSTOMER_PII_PERMISSION_KEYS,
  customerPiiAccessRequest,
  operationsCustomerCsv,
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
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const MAX_EXPORT_ROWS = 5_000;

export async function POST(request: Request) {
  try {
    const view = await requireAccessPermission(request, "ops.customers.view");
    await requireAccessPermission(request, "ops.customers.export");
    const { user, access, scope, organizationIds } = view;
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
    const values = [...filter.values, MAX_EXPORT_ROWS + 1];
    const pool = await getPostgresPool();
    const result = await pool.query(`
      SELECT customer.id,customer.status,customer.created_at
        FROM users customer
        LEFT JOIN customer_profiles profile ON profile.customer_id=customer.id
       WHERE ${filter.where.join(" AND ")}
       ORDER BY customer.created_at DESC,customer.id DESC
       LIMIT $${values.length}
    `, values);
    if (result.rows.length > MAX_EXPORT_ROWS) {
      throw new ResearchApiError("CUSTOMER_EXPORT_TOO_LARGE", "导出结果超过 5000 行，请缩小筛选范围", 422, { maxRows: MAX_EXPORT_ROWS });
    }
    const piiRows = await loadOperationsCustomerPii(pool, result.rows.map((row) => row.id));
    const rows = result.rows.map((row) => ({
      customerId: row.id,
      status: row.status,
      registeredAt: new Date(row.created_at).toISOString(),
      pii: projectOperationsCustomerPii(operationsCustomerPiiOrEmpty(piiRows, row.id), piiAccess.categories),
    }));
    const exportId = crypto.randomUUID();
    const audit = {
      actorUserId: user.id,
      subjectType: "customer_collection" as const,
      subjectId: exportId,
      categories: piiAccess.categories,
      reason: piiAccess.reason ?? "导出非敏感客户字段",
      scope: effectiveScope.scope,
      organizationIds: effectiveScope.organizationIds,
      resultCount: rows.length,
      requestId: request.headers.get("x-request-id"),
    };
    await recordOperationsCustomerPiiAudit(pool, { ...audit, action: "customer.pii_export_generated" });
    await recordOperationsCustomerPiiAudit(pool, { ...audit, action: "customer.pii_export_downloaded" });
    return new Response(operationsCustomerCsv(rows, piiAccess.categories), {
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`,
        "x-content-type-options": "nosniff",
        "x-export-id": exportId,
        "x-export-retention": "none",
      },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
