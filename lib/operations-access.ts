import type { DataScope } from "./rbac.ts";

export type OperationsIdentity = { userId: string; organizationId: string | null };

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
) {
  if (scope === "PLATFORM") return { clause: "TRUE", values: [] as unknown[] };
  if (scope === "SELF") return { clause: `${customerIdColumn} = $${startIndex}`, values: [identity.userId] as unknown[] };
  if (scope === "DIRECT_REPORTS") {
    return {
      clause: `EXISTS (SELECT 1 FROM customer_attributions scope_ca WHERE scope_ca.customer_id = ${customerIdColumn} AND scope_ca.employee_id = $${startIndex})`,
      values: [identity.userId] as unknown[],
    };
  }
  if (scope === "TEAM_TREE") {
    return {
      clause: `EXISTS (SELECT 1 FROM customer_attributions scope_ca WHERE scope_ca.customer_id = ${customerIdColumn} AND (scope_ca.manager_id = $${startIndex} OR scope_ca.supervisor_id = $${startIndex} OR scope_ca.employee_id = $${startIndex}))`,
      values: [identity.userId] as unknown[],
    };
  }
  if (!identity.organizationId) return { clause: "FALSE", values: [] as unknown[] };
  return { clause: `${resourceAlias}.branch_id = $${startIndex}`, values: [identity.organizationId] as unknown[] };
}
