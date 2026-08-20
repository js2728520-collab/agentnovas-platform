import type { PoolClient } from "pg";

import { accessOrganizationResourcePredicate, type AccessActor } from "./access-center-scope.ts";
import type { AppAudience } from "./riverton-apps.ts";
import type { DataScope } from "./rbac.ts";

export async function lockScopedRoleForTarget(client: Pick<PoolClient, "query">, input: {
  roleId: string;
  appId: AppAudience;
  targetOrganizationId: string | null;
  scope: DataScope;
  actor: AccessActor;
  organizationIds: readonly string[];
}) {
  const values: unknown[] = [input.roleId, input.appId, input.targetOrganizationId];
  const resourceScope = accessOrganizationResourcePredicate({
    scope: input.scope,
    actor: input.actor,
    organizationIds: input.organizationIds,
    columns: ["role_target.created_organization_id", "role_target.applies_to_organization_id"],
    startIndex: values.length + 1,
  });
  values.push(...resourceScope.values);
  const result = await client.query<{ id: string; application_id: string }>(`
    SELECT role_target.id, role_target.application_id
    FROM roles AS role_target
    WHERE role_target.id = $1
      AND role_target.application_id = $2
      AND role_target.status = 'published'
      AND (${resourceScope.clause})
      AND (
        role_target.applies_to_organization_id IS NULL
        OR role_target.applies_to_organization_id = $3
      )
    FOR UPDATE OF role_target
  `, values);
  return result.rows[0] ?? null;
}
