import { ResearchApiError } from "./research-errors.ts";
import { DATA_SCOPES, PERMISSION_DEFINITIONS, type DataScope, type RolePermission } from "./rbac.ts";
import { isAppAudience, type AppAudience } from "./riverton-apps.ts";

export const ACCESS_ADMIN_PERMISSIONS = ["ops.roles.manage", "maint.roles.manage"] as const;

export function parseAccessAppId(value: unknown): AppAudience {
  const appId = String(value ?? "");
  if (!isAppAudience(appId)) throw new ResearchApiError("VALIDATION_ERROR", "应用无效", 422, { fields: ["applicationId"] });
  return appId;
}

export function parseRolePermissions(value: unknown, appId?: AppAudience): RolePermission[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ResearchApiError("VALIDATION_ERROR", "权限列表无效", 422, { fields: ["permissions"] });
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new ResearchApiError("VALIDATION_ERROR", "权限项无效", 422, { fields: [`permissions.${index}`] });
    }
    const permissionKey = String("permissionKey" in item ? item.permissionKey : "");
    const scope = String("scope" in item ? item.scope : "") as DataScope;
    const definition = PERMISSION_DEFINITIONS.find((permission) => permission.key === permissionKey);
    if (!definition) throw new ResearchApiError("VALIDATION_ERROR", "权限未注册", 422, { fields: [`permissions.${index}.permissionKey`] });
    if (appId && definition.appId !== appId) throw new ResearchApiError("VALIDATION_ERROR", "权限不属于当前应用", 422, { fields: [`permissions.${index}.permissionKey`] });
    if (!(DATA_SCOPES as readonly string[]).includes(scope)) throw new ResearchApiError("VALIDATION_ERROR", "数据范围无效", 422, { fields: [`permissions.${index}.scope`] });
    return { permissionKey, scope };
  });
}

export function limitedText(value: unknown, field: string, maximum = 120) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum) throw new ResearchApiError("VALIDATION_ERROR", `${field} 无效`, 422, { fields: [field] });
  return text;
}

