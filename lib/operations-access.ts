import type { DataScope } from "./rbac.ts";

export type OperationsIdentity = { userId: string; organizationId: string | null };

function effectiveOrganizationIds(identity: OperationsIdentity, assignmentOrganizationIds: readonly string[]) {
  return assignmentOrganizationIds.length
    ? [...new Set(assignmentOrganizationIds)]
    : identity.organizationId ? [identity.organizationId] : [];
}

export function maskOperationsEmail(value: string | null) {
  if (!value) return null;
  const [name, domain] = value.split("@");
  if (!domain) return "***";
  return `${name.slice(0, 2)}***@${domain}`;
}

export function maskOperationsValue(value: string | null) {
  if (!value) return null;
  return value.length <= 4 ? "****" : `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function customerScopePredicate(
  scope: DataScope,
  identity: OperationsIdentity,
  resourceAlias: string,
  customerIdColumn: string,
  startIndex = 1,
  assignmentOrganizationIds: readonly string[] = [],
) {
  if (scope === "PLATFORM") return { clause: "TRUE", values: [] as unknown[] };
  if (scope === "SELF") return { clause: `${customerIdColumn} = $${startIndex}`, values: [identity.userId] as unknown[] };
  const boundedOrganizationIds = effectiveOrganizationIds(identity, assignmentOrganizationIds);
  if (scope === "DIRECT_REPORTS") {
    const organizationClause = boundedOrganizationIds.length
      ? ` AND scope_ca.branch_id = ANY($${startIndex + 1}::text[])`
      : "";
    return {
      clause: `EXISTS (SELECT 1 FROM customer_attributions scope_ca WHERE scope_ca.customer_id = ${customerIdColumn} AND scope_ca.status = 'active' AND scope_ca.employee_id = $${startIndex}${organizationClause})`,
      values: boundedOrganizationIds.length ? [identity.userId, boundedOrganizationIds] as unknown[] : [identity.userId] as unknown[],
    };
  }
  if (scope === "TEAM_TREE") {
    const organizationClause = boundedOrganizationIds.length
      ? ` AND scope_ca.branch_id = ANY($${startIndex + 1}::text[])`
      : "";
    return {
      clause: `EXISTS (SELECT 1 FROM customer_attributions scope_ca WHERE scope_ca.customer_id = ${customerIdColumn} AND scope_ca.status = 'active' AND (scope_ca.manager_id = $${startIndex} OR scope_ca.supervisor_id = $${startIndex} OR scope_ca.employee_id = $${startIndex})${organizationClause})`,
      values: boundedOrganizationIds.length ? [identity.userId, boundedOrganizationIds] as unknown[] : [identity.userId] as unknown[],
    };
  }
  if (!boundedOrganizationIds.length) return { clause: "FALSE", values: [] as unknown[] };
  return {
    clause: `${resourceAlias}.branch_id = ANY($${startIndex}::text[])`,
    values: [boundedOrganizationIds] as unknown[],
  };
}

export function organizationScopePredicate(
  scope: DataScope,
  identity: OperationsIdentity,
  organizationIdColumn: string,
  startIndex = 1,
  assignmentOrganizationIds: readonly string[] = [],
) {
  if (scope === "PLATFORM") return { clause: "TRUE", values: [] as unknown[] };
  if (scope !== "ORGANIZATION" && scope !== "ORGANIZATION_SET") return { clause: "FALSE", values: [] as unknown[] };
  const organizationIds = effectiveOrganizationIds(identity, assignmentOrganizationIds);
  if (!organizationIds.length) return { clause: "FALSE", values: [] as unknown[] };
  return {
    clause: `${organizationIdColumn} = ANY($${startIndex}::text[])`,
    values: [organizationIds] as unknown[],
  };
}

export function canAccessOrganization(
  scope: DataScope,
  identity: OperationsIdentity,
  organizationId: string,
  assignmentOrganizationIds: readonly string[] = [],
) {
  return scope === "PLATFORM" || (
    (scope === "ORGANIZATION" || scope === "ORGANIZATION_SET") &&
    effectiveOrganizationIds(identity, assignmentOrganizationIds).includes(organizationId)
  );
}
