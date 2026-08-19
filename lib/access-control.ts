import type { Pool } from "pg";

import { currentUser, type CurrentUser } from "@/lib/session";
import { ResearchApiError } from "@/lib/research-errors";
import { getPostgresPool } from "@/lib/postgres";
import { resolveAppAudience, type AppAudience } from "@/lib/riverton-apps";
import {
  PERMISSION_DEFINITIONS,
  effectivePermissionMap,
  legacyPermissionsForApp,
  type DataScope,
} from "@/lib/rbac";

export type EffectiveAccess = {
  appId: AppAudience;
  permissions: Record<string, DataScope>;
  source: "rbac" | "legacy_role";
};

export async function effectiveAccessForUser(pool: Pool, user: CurrentUser, appId: AppAudience): Promise<EffectiveAccess> {
  try {
    const result = await pool.query<{
      permission_key: string;
      scope: DataScope;
    }>(`
      SELECT rp.permission_key, rp.scope
      FROM user_role_assignments AS ura
      INNER JOIN roles AS r ON r.id = ura.role_id
      INNER JOIN role_permissions AS rp ON rp.role_id = r.id
      WHERE ura.user_id = $1
        AND ura.application_id = $2
        AND ura.status = 'active'
        AND r.status = 'published'
        AND ura.effective_at <= now()
        AND (ura.expires_at IS NULL OR ura.expires_at > now())
    `, [user.id, appId]);
    if (result.rows.length > 0) {
      return {
        appId,
        permissions: effectivePermissionMap(result.rows.map((row) => ({
          permissionKey: row.permission_key,
          scope: row.scope,
        }))),
        source: "rbac",
      };
    }
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "42P01" && code !== "42703") throw error;
  }
  return {
    appId,
    permissions: effectivePermissionMap(legacyPermissionsForApp(user.role, appId)),
    source: "legacy_role",
  };
}

export async function requireAccessPermission(request: Request, permissionKey: string) {
  const user = await currentUser(request);
  if (!user) throw new ResearchApiError("AUTH_REQUIRED", "请先登录", 401);
  const definition = PERMISSION_DEFINITIONS.find((permission) => permission.key === permissionKey);
  if (!definition) throw new ResearchApiError("PERMISSION_UNKNOWN", "权限未注册", 500, { permissionKey });
  const pool = await getPostgresPool();
  const access = await effectiveAccessForUser(pool, user, definition.appId);
  const scope = access.permissions[permissionKey];
  if (!scope) throw new ResearchApiError("FORBIDDEN", "无权执行此操作", 403, { permissionKey });
  return { user, access, scope };
}

export async function requireAnyAccessPermission(request: Request, permissionKeys: string[]) {
  let lastForbidden: ResearchApiError | null = null;
  for (const permissionKey of permissionKeys) {
    try {
      return await requireAccessPermission(request, permissionKey);
    } catch (error) {
      if (error instanceof ResearchApiError && error.status === 403) {
        lastForbidden = error;
        continue;
      }
      throw error;
    }
  }
  throw lastForbidden ?? new ResearchApiError("FORBIDDEN", "无权执行此操作", 403);
}

export function currentRequestAudience(request: Request) {
  return resolveAppAudience({ host: request.headers.get("host") ?? undefined });
}

export function permissionDefinitionsForApp(appId: AppAudience) {
  return PERMISSION_DEFINITIONS.filter((permission) => permission.appId === appId);
}
