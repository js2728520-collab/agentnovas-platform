import { legacyPermissionsForApp, type DataScope } from "./rbac.ts";
import type { AppAudience } from "./riverton-apps.ts";
import type { Pool } from "pg";

export type AssignmentPermissionRow = {
  permissionKey: string;
  scope: DataScope;
  assignmentOrganizationId: string | null;
  assignmentOrganizationIds: unknown;
  permissionOrganizationIds: unknown;
};

export type EffectivePermissionGrant = {
  scope: DataScope;
  organizationIds: string[];
};

export type ResolvedEffectiveAccess = {
  permissions: Record<string, DataScope>;
  grants: Record<string, EffectivePermissionGrant>;
  source: "rbac" | "legacy_role";
};

const scopeRank: Record<DataScope, number> = {
  SELF: 0,
  DIRECT_REPORTS: 1,
  TEAM_TREE: 2,
  ORGANIZATION: 3,
  ORGANIZATION_SET: 4,
  PLATFORM: 5,
};

function organizationIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 160))].sort();
}

function boundedOrganizationIds(row: AssignmentPermissionRow) {
  const assignment = organizationIds(row.assignmentOrganizationIds);
  if (!assignment.length && row.assignmentOrganizationId) assignment.push(row.assignmentOrganizationId);
  const permission = organizationIds(row.permissionOrganizationIds);
  if (!permission.length) return assignment;
  if (!assignment.length) return permission;
  const permitted = new Set(permission);
  return assignment.filter((organizationId) => permitted.has(organizationId));
}

function rbacAccess(rows: AssignmentPermissionRow[]): ResolvedEffectiveAccess {
  const grants = new Map<string, EffectivePermissionGrant>();
  for (const row of rows) {
    const ids = boundedOrganizationIds(row);
    if ((row.scope === "ORGANIZATION" || row.scope === "ORGANIZATION_SET") && !ids.length) continue;
    const incoming: EffectivePermissionGrant = {
      scope: row.scope,
      organizationIds: row.scope === "PLATFORM" ? [] : ids,
    };
    const current = grants.get(row.permissionKey);
    if (current && ["ORGANIZATION", "ORGANIZATION_SET"].includes(current.scope)
      && ["ORGANIZATION", "ORGANIZATION_SET"].includes(incoming.scope)) {
      current.scope = scopeRank[incoming.scope] > scopeRank[current.scope] ? incoming.scope : current.scope;
      current.organizationIds = [...new Set([...current.organizationIds, ...incoming.organizationIds])].sort();
      continue;
    }
    if (!current || scopeRank[incoming.scope] > scopeRank[current.scope]) {
      grants.set(row.permissionKey, incoming);
      continue;
    }
    if (scopeRank[incoming.scope] === scopeRank[current.scope]) {
      current.organizationIds = [...new Set([...current.organizationIds, ...incoming.organizationIds])].sort();
    }
  }
  const normalized = Object.fromEntries([...grants.entries()].sort(([left], [right]) => left.localeCompare(right)));
  return {
    source: "rbac",
    grants: normalized,
    permissions: Object.fromEntries(Object.entries(normalized).map(([key, grant]) => [key, grant.scope])),
  };
}

export function resolveEffectiveAccess(input: {
  appId: AppAudience;
  legacyRole: string;
  hasAnyAssignment: boolean;
  hasRevocationTombstone: boolean;
  rows: AssignmentPermissionRow[];
}): ResolvedEffectiveAccess {
  if (input.rows.length || input.appId !== "client" || input.hasAnyAssignment || input.hasRevocationTombstone) {
    return rbacAccess(input.rows);
  }
  const legacy = legacyPermissionsForApp(input.legacyRole, input.appId);
  const grants = Object.fromEntries(legacy.map((permission) => [permission.permissionKey, {
    scope: permission.scope,
    organizationIds: [],
  }]));
  return {
    source: "legacy_role",
    grants,
    permissions: Object.fromEntries(Object.entries(grants).map(([key, grant]) => [key, grant.scope])),
  };
}

export async function loadEffectiveAccess(
  pool: Pick<Pool, "query">,
  user: { id: string; role: string },
  appId: AppAudience,
) {
  try {
    const state = await pool.query<{
      has_any_assignment: boolean;
      has_revocation_tombstone: boolean;
    }>(`
      SELECT
        EXISTS (
          SELECT 1 FROM user_role_assignments
          WHERE user_id = $1 AND application_id = $2
        ) AS has_any_assignment,
        EXISTS (
          SELECT 1 FROM rbac_revocation_tombstones
          WHERE user_id = $1 AND application_id = $2
        ) AS has_revocation_tombstone
    `, [user.id, appId]);
    const result = await pool.query<{
      permission_key: string;
      scope: DataScope;
      assignment_organization_id: string | null;
      assignment_organization_ids: unknown;
      permission_organization_ids: unknown;
    }>(`
      SELECT rp.permission_key, rp.scope,
             ura.organization_id AS assignment_organization_id,
             ura.scope_organization_ids_json AS assignment_organization_ids,
             rp.scope_organization_ids_json AS permission_organization_ids
      FROM user_role_assignments AS ura
      INNER JOIN roles AS r ON r.id = ura.role_id
      INNER JOIN role_permissions AS rp ON rp.role_id = r.id
      INNER JOIN permission_definitions AS pd ON pd.key = rp.permission_key
      WHERE ura.user_id = $1
        AND ura.application_id = $2
        AND ura.status = 'active'
        AND r.status = 'published'
        AND r.application_id = ura.application_id
        AND pd.application_id = ura.application_id
        AND pd.status = 'active'
        AND ura.effective_at <= now()
        AND (ura.expires_at IS NULL OR ura.expires_at > now())
    `, [user.id, appId]);
    return resolveEffectiveAccess({
      appId,
      legacyRole: user.role,
      hasAnyAssignment: Boolean(state.rows[0]?.has_any_assignment),
      hasRevocationTombstone: Boolean(state.rows[0]?.has_revocation_tombstone),
      rows: result.rows.map((row) => ({
        permissionKey: row.permission_key,
        scope: row.scope,
        assignmentOrganizationId: row.assignment_organization_id,
        assignmentOrganizationIds: row.assignment_organization_ids,
        permissionOrganizationIds: row.permission_organization_ids,
      })),
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "42P01" && code !== "42703") throw error;
    return resolveEffectiveAccess({
      appId,
      legacyRole: user.role,
      hasAnyAssignment: false,
      hasRevocationTombstone: false,
      rows: [],
    });
  }
}
