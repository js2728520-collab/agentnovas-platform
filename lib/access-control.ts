import type { Pool } from "pg";

import { currentSession, type CurrentUser } from "@/lib/session";
import { requireCommercialLegalConsentGate } from "@/lib/commercial-legal-consent-gate";
import { ResearchApiError } from "@/lib/research-errors";
import { getPostgresPool } from "@/lib/postgres";
import { loadEffectiveAccess, type EffectivePermissionGrant } from "@/lib/effective-access";
import { resolveAppAudienceStrict, type AppAudience } from "@/lib/riverton-apps";
import {
  PERMISSION_DEFINITIONS,
  type DataScope,
} from "@/lib/rbac";

export type EffectiveAccess = {
  appId: AppAudience;
  permissions: Record<string, DataScope>;
  grants: Record<string, EffectivePermissionGrant>;
  source: "rbac" | "legacy_role";
};

export async function effectiveAccessForUser(pool: Pool, user: CurrentUser, appId: AppAudience): Promise<EffectiveAccess> {
  return {
    appId,
    ...await loadEffectiveAccess(pool, user, appId),
  };
}

export async function requireAccessPermission(request: Request, permissionKey: string) {
  const current = await currentSession(request);
  if (!current) throw new ResearchApiError("AUTH_REQUIRED", "请先登录", 401);
  const user = current.user;
  const definition = PERMISSION_DEFINITIONS.find((permission) => permission.key === permissionKey);
  if (!definition) throw new ResearchApiError("PERMISSION_UNKNOWN", "权限未注册", 500, { permissionKey });
  const requestAudience = currentRequestAudience(request);
  if (requestAudience !== definition.appId) throw new ResearchApiError("NOT_FOUND", "接口在当前应用不可用", 404);
  if (definition.sensitive && definition.appId !== "client" && !current.recentMfa) {
    throw new ResearchApiError("RECENT_MFA_REQUIRED", "请在 15 分钟内重新完成双重验证", 403, { maxAgeSeconds: 900 });
  }
  const pool = await getPostgresPool();
  const access = await effectiveAccessForUser(pool, user, definition.appId);
  const grant = access.grants[permissionKey];
  if (!grant) throw new ResearchApiError("FORBIDDEN", "无权执行此操作", 403, { permissionKey });
  if (definition.appId === "maintenance" && grant.scope !== "PLATFORM") {
    throw new ResearchApiError("FORBIDDEN", "运维权限必须显式授予平台范围", 403, { permissionKey });
  }
  if (definition.appId === "client") await requireCommercialLegalConsentGate(pool, user.id);
  return { user, access, scope: grant.scope, organizationIds: grant.organizationIds };
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
  const audience = resolveAppAudienceStrict({ host: request.headers.get("host") ?? undefined });
  if (!audience) throw new ResearchApiError("NOT_FOUND", "接口在当前应用不可用", 404);
  return audience;
}

export async function requireCurrentAccessAdmin(request: Request) {
  const appId = currentRequestAudience(request);
  const permissionKey = appId === "operations" ? "ops.roles.manage"
    : appId === "maintenance" ? "maint.roles.manage" : null;
  if (!permissionKey) throw new ResearchApiError("FORBIDDEN", "当前应用不提供角色管理", 403);
  const result = await requireAccessPermission(request, permissionKey);
  return { ...result, appId };
}

export async function requireCurrentAccessViewer(request: Request) {
  const appId = currentRequestAudience(request);
  const permissionKeys = appId === "operations"
    ? ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive"]
    : appId === "maintenance"
      ? ["maint.roles.manage", "maint.roles.approve_sensitive"]
      : [];
  if (!permissionKeys.length) throw new ResearchApiError("FORBIDDEN", "当前应用不提供授权中心", 403);
  const result = await requireAnyAccessPermission(request, permissionKeys);
  return { ...result, appId };
}

export async function requireCurrentAccessAssignmentAdmin(request: Request) {
  const appId = currentRequestAudience(request);
  const permissionKeys = appId === "operations" ? ["ops.roles.assign", "ops.roles.manage"]
    : appId === "maintenance" ? ["maint.roles.manage"] : [];
  if (!permissionKeys.length) throw new ResearchApiError("FORBIDDEN", "当前应用不提供角色分配", 403);
  const result = await requireAnyAccessPermission(request, permissionKeys);
  return { ...result, appId };
}

export async function requireCurrentAccessReviewer(request: Request) {
  const appId = currentRequestAudience(request);
  const permissionKeys = appId === "operations" ? ["ops.roles.approve_sensitive", "ops.roles.manage"]
    : appId === "maintenance" ? ["maint.roles.approve_sensitive", "maint.roles.manage"] : [];
  if (!permissionKeys.length) throw new ResearchApiError("FORBIDDEN", "当前应用不提供授权审批", 403);
  const result = await requireAnyAccessPermission(request, permissionKeys);
  return { ...result, appId };
}

export async function requireCurrentAccessAudit(request: Request) {
  const appId = currentRequestAudience(request);
  const permissionKeys = appId === "operations" ? ["ops.roles.manage", "ops.roles.approve_sensitive"]
    : appId === "maintenance" ? ["maint.audit.view", "maint.roles.manage"] : [];
  if (!permissionKeys.length) throw new ResearchApiError("FORBIDDEN", "当前应用不提供授权审计", 403);
  const result = await requireAnyAccessPermission(request, permissionKeys);
  return { ...result, appId };
}

export function permissionDefinitionsForApp(appId: AppAudience) {
  return PERMISSION_DEFINITIONS.filter((permission) => permission.appId === appId);
}
