import { commercialCustomerScopePredicate } from "./commercial-operations-scope.ts";
import type { OperationsIdentity } from "./operations-access.ts";
import type { DataScope } from "./rbac.ts";
import { ResearchApiError } from "./research-errors.ts";

export function operationsCustomerFilter(
  request: Request,
  scope: DataScope,
  identity: OperationsIdentity,
  organizationIds: readonly string[],
  canSearchEmail: boolean,
) {
  const url = new URL(request.url);
  const values: unknown[] = [];
  const where = ["customer.role='customer'"];
  const status = url.searchParams.get("status")?.trim() ?? "";
  if (status) {
    if (!["active", "pending", "frozen", "closed"].includes(status)) {
      throw new ResearchApiError("CUSTOMER_STATUS_INVALID", "客户状态筛选无效", 422);
    }
    values.push(status);
    where.push(`customer.status=$${values.length}`);
  }
  const query = url.searchParams.get("query")?.trim() ?? "";
  if (query.length > 120) throw new ResearchApiError("CUSTOMER_QUERY_INVALID", "客户搜索条件过长", 422);
  if (query) {
    values.push(`%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    where.push(`(customer.id ILIKE $${values.length} ESCAPE '\\'${canSearchEmail ? ` OR customer.email ILIKE $${values.length} ESCAPE '\\'` : ""} OR profile.display_name ILIKE $${values.length} ESCAPE '\\')`);
  }
  const scoped = commercialCustomerScopePredicate(
    scope,
    identity,
    "scope_customer_list",
    "customer.id",
    values.length + 1,
    organizationIds,
  );
  values.push(...scoped.values);
  where.push(scoped.clause);
  return { url, values, where, query, status };
}
