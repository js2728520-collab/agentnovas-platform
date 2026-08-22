import type { QueryResult, QueryResultRow } from "pg";

import {
  canAccessCustomerAttribution,
  customerScopePredicate,
  type OperationsIdentity,
} from "./operations-access.ts";
import type { DataScope } from "./rbac.ts";
import { ResearchApiError } from "./research-errors.ts";

export type CommercialScopeQueryable = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};

export type CommercialOperationsScopeInput = {
  scope: DataScope;
  identity: OperationsIdentity;
  organizationIds: readonly string[];
  customerId: string;
};

export type CommercialOperationsScopeResolver = (
  client: CommercialScopeQueryable,
  input: CommercialOperationsScopeInput,
) => Promise<boolean>;

type AttributionRow = {
  customer_id: string;
  branch_id: string | null;
  manager_id: string | null;
  supervisor_id: string | null;
  employee_id: string | null;
};

function activeAttributionClause(alias: string, customerIdColumn: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias))
    throw new Error("COMMERCIAL_SCOPE_ALIAS_INVALID");
  return `EXISTS (SELECT 1 FROM customer_attributions ${alias} WHERE ${alias}.customer_id = ${customerIdColumn} AND ${alias}.status = 'active')`;
}

function hasBoundOrganization(
  identity: OperationsIdentity,
  organizationIds: readonly string[],
) {
  return organizationIds.length > 0 || Boolean(identity.organizationId);
}

export function commercialCustomerScopePredicate(
  scope: DataScope,
  identity: OperationsIdentity,
  resourceAlias: string,
  customerIdColumn: string,
  startIndex: number,
  organizationIds: readonly string[],
) {
  if (
    (scope === "DIRECT_REPORTS" || scope === "TEAM_TREE") &&
    !hasBoundOrganization(identity, organizationIds)
  )
    return { clause: "FALSE", values: [] as unknown[] };

  const scoped = customerScopePredicate(
    scope,
    identity,
    resourceAlias,
    customerIdColumn,
    startIndex,
    organizationIds,
  );
  if (scope === "DIRECT_REPORTS" || scope === "TEAM_TREE") return scoped;

  const activeAttribution = activeAttributionClause(
    resourceAlias,
    customerIdColumn,
  );
  if (scope === "PLATFORM") return scoped;
  if (scope === "SELF")
    return {
      clause: `(${scoped.clause}) AND ${activeAttribution}`,
      values: scoped.values,
    };
  return {
    clause: `EXISTS (SELECT 1 FROM customer_attributions ${resourceAlias} WHERE ${resourceAlias}.customer_id = ${customerIdColumn} AND ${resourceAlias}.status = 'active' AND ${scoped.clause})`,
    values: scoped.values,
  };
}

function attribution(row: AttributionRow) {
  return {
    customerId: row.customer_id,
    branchId: row.branch_id,
    managerId: row.manager_id,
    supervisorId: row.supervisor_id,
    employeeId: row.employee_id,
  };
}

function canAccessRows(
  rows: AttributionRow[],
  input: CommercialOperationsScopeInput,
) {
  if (
    input.scope !== "PLATFORM" &&
    input.scope !== "SELF" &&
    !hasBoundOrganization(input.identity, input.organizationIds)
  )
    return false;
  return rows.some((row) =>
    canAccessCustomerAttribution(
      input.scope,
      input.identity,
      attribution(row),
      input.organizationIds,
    ),
  );
}

/**
 * Accepts a PoolClient-compatible query surface so mutation services can repeat
 * the scope check after taking their business-row lock. A route-only Pool check
 * is defense in depth, but does not by itself close the authorization TOCTOU.
 */
export const resolveOperationsCustomerScope: CommercialOperationsScopeResolver =
  async (client, input) => {
    if (input.scope === "PLATFORM") {
      const customer = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id=$1 FOR SHARE`,
        [input.customerId],
      );
      return Boolean(customer.rows[0]);
    }
    const result = await client.query<AttributionRow>(
      `SELECT customer_id,branch_id,manager_id,supervisor_id,employee_id
       FROM customer_attributions
       WHERE customer_id=$1 AND status='active'
       FOR SHARE`,
      [input.customerId],
    );
    return canAccessRows(result.rows, input);
  };

function resourceNotFound(): never {
  throw new ResearchApiError(
    "RESOURCE_NOT_FOUND",
    "资源不存在或不在当前数据范围",
    404,
  );
}

export async function assertOperationsCustomerScope(
  client: CommercialScopeQueryable,
  scope: DataScope,
  identity: OperationsIdentity,
  customerId: string,
  organizationIds: readonly string[],
) {
  if (
    !(await resolveOperationsCustomerScope(client, {
      scope,
      identity,
      organizationIds,
      customerId,
    }))
  )
    resourceNotFound();
}

export function operationsCustomerScopeAuthorization(
  scope: DataScope,
  identity: OperationsIdentity,
  organizationIds: readonly string[],
) {
  return (client: CommercialScopeQueryable, customerId: string) =>
    assertOperationsCustomerScope(
      client,
      scope,
      identity,
      customerId,
      organizationIds,
    );
}

async function assertOperationsResourceScope(
  client: CommercialScopeQueryable,
  input: Omit<CommercialOperationsScopeInput, "customerId">,
  table: "commercial_membership_orders" | "performance_fee_statements",
  resourceId: string,
) {
  const resourceAlias = table === "commercial_membership_orders" ? "o" : "s";
  if (input.scope === "PLATFORM") {
    const resource = await client.query<{ user_id: string }>(
      `SELECT ${resourceAlias}.user_id
       FROM ${table} ${resourceAlias}
       WHERE ${resourceAlias}.id=$1
       FOR SHARE OF ${resourceAlias}`,
      [resourceId],
    );
    if (!resource.rows[0]) resourceNotFound();
    return;
  }
  const result = await client.query<AttributionRow>(
    `SELECT scope_ca.customer_id,scope_ca.branch_id,scope_ca.manager_id,
            scope_ca.supervisor_id,scope_ca.employee_id
     FROM ${table} ${resourceAlias}
     JOIN customer_attributions scope_ca
       ON scope_ca.customer_id=${resourceAlias}.user_id
      AND scope_ca.status='active'
     WHERE ${resourceAlias}.id=$1
     FOR SHARE OF ${resourceAlias},scope_ca`,
    [resourceId],
  );
  if (
    !canAccessRows(result.rows, {
      ...input,
      customerId: result.rows[0]?.customer_id ?? "",
    })
  )
    resourceNotFound();
}

export function assertOperationsOrderScope(
  client: CommercialScopeQueryable,
  scope: DataScope,
  identity: OperationsIdentity,
  orderId: string,
  organizationIds: readonly string[],
) {
  return assertOperationsResourceScope(
    client,
    { scope, identity, organizationIds },
    "commercial_membership_orders",
    orderId,
  );
}

export function assertOperationsStatementScope(
  client: CommercialScopeQueryable,
  scope: DataScope,
  identity: OperationsIdentity,
  statementId: string,
  organizationIds: readonly string[],
) {
  return assertOperationsResourceScope(
    client,
    { scope, identity, organizationIds },
    "performance_fee_statements",
    statementId,
  );
}
