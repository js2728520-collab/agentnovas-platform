import { ResearchApiError } from "./research-errors.ts";
import { parseAccessAppId, parseRolePermissions, limitedText } from "./access-management.ts";
import type { AppAudience } from "./riverton-apps.ts";
import type { RolePermission } from "./rbac.ts";

export type RoleCreateChange = {
  changeType: "role_create";
  applicationId: AppAudience;
  targetUserId: null;
  targetRoleId: null;
  before: Record<string, never>;
  after: { code: string; name: string; permissions: RolePermission[] };
};
export type RoleUpdateChange = {
  changeType: "role_update";
  applicationId: AppAudience;
  targetUserId: null;
  targetRoleId: string;
  before: Record<string, unknown>;
  after: { name: string };
};
export type RoleAssignChange = {
  changeType: "role_assign";
  applicationId: AppAudience;
  targetUserId: string;
  targetRoleId: string;
  before: Record<string, never>;
  after: { expiresAt: string | null; reason: string };
};
export type RoleRevokeChange = {
  changeType: "role_revoke";
  applicationId: AppAudience;
  targetUserId: string;
  targetRoleId: string;
  before: Record<string, never>;
  after: { assignmentId: string; reason: string };
};
export type TemplatePublishChange = {
  changeType: "template_publish";
  applicationId: AppAudience;
  targetUserId: null;
  targetRoleId: null;
  before: Record<string, never>;
  after: { code: string; name: string; permissions: RolePermission[]; changeSummary: string };
};
export type AccessChange = RoleCreateChange | RoleUpdateChange | RoleAssignChange | RoleRevokeChange | TemplatePublishChange;

const ID_MAX = 160;
const allowedKeys = (value: Record<string, unknown>, keys: readonly string[], field: string) => {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ResearchApiError("VALIDATION_ERROR", `${field} 包含不允许的字段`, 422, { fields: [field] });
  }
};
const object = (value: unknown, field: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResearchApiError("VALIDATION_ERROR", `${field} 无效`, 422, { fields: [field] });
  return value as Record<string, unknown>;
};
const id = (value: unknown, field: string) => {
  const result = String(value ?? "").trim();
  if (!result || result.length > ID_MAX) throw new ResearchApiError("VALIDATION_ERROR", `${field} 无效`, 422, { fields: [field] });
  return result;
};
const emptyObject = (value: unknown, field: string) => {
  const result = object(value, field);
  allowedKeys(result, [], field);
  return {} as Record<string, never>;
};
const optionalReason = (value: unknown) => {
  if (value === undefined) return "";
  return String(value).trim().slice(0, 500);
};
function expiry(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const text = id(value, "after.expiresAt");
  const date = new Date(text);
  const now = Date.now();
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now || date.getTime() > now + 366 * 24 * 60 * 60 * 1000) {
    throw new ResearchApiError("VALIDATION_ERROR", "过期时间必须在未来一年内", 422, { fields: ["after.expiresAt"] });
  }
  return date.toISOString();
}

export function parseAccessChangeRequest(body: Record<string, unknown>): AccessChange {
  const requestKeys = new Set(["applicationId", "changeType", "targetUserId", "targetRoleId", "before", "after", "reason"]);
  if (Object.keys(body).some((key) => !requestKeys.has(key))) {
    throw new ResearchApiError("VALIDATION_ERROR", "申请包含不允许的字段", 422, { fields: ["request"] });
  }
  const changeType = String(body.changeType ?? "");
  const applicationId = parseAccessAppId(body.applicationId);
  const before = object(body.before ?? {}, "before");
  const after = object(body.after ?? {}, "after");
  switch (changeType) {
    case "role_create": {
      if (body.targetUserId != null || body.targetRoleId != null) throw new ResearchApiError("VALIDATION_ERROR", "角色创建不能指定目标", 422);
      allowedKeys(before, [], "before"); allowedKeys(after, ["code", "name", "permissions"], "after");
      return { changeType, applicationId, targetUserId: null, targetRoleId: null, before: emptyObject(before, "before"), after: { code: limitedText(after.code, "after.code", 80), name: limitedText(after.name, "after.name", 120), permissions: parseRolePermissions(after.permissions, applicationId) } };
    }
    case "role_update":
      if (body.targetUserId != null) throw new ResearchApiError("VALIDATION_ERROR", "角色更新不能指定用户", 422);
      allowedKeys(before, [], "before"); allowedKeys(after, ["name"], "after");
      return { changeType, applicationId, targetUserId: null, targetRoleId: id(body.targetRoleId, "targetRoleId"), before: {}, after: { name: limitedText(after.name, "after.name", 120) } };
    case "role_assign":
      allowedKeys(before, [], "before"); allowedKeys(after, ["expiresAt", "reason"], "after");
      return { changeType, applicationId, targetUserId: id(body.targetUserId, "targetUserId"), targetRoleId: id(body.targetRoleId, "targetRoleId"), before: {}, after: { expiresAt: expiry(after.expiresAt), reason: optionalReason(after.reason) } };
    case "role_revoke":
      allowedKeys(before, [], "before"); allowedKeys(after, ["assignmentId", "reason"], "after");
      return { changeType, applicationId, targetUserId: id(body.targetUserId, "targetUserId"), targetRoleId: id(body.targetRoleId, "targetRoleId"), before: {}, after: { assignmentId: id(after.assignmentId, "after.assignmentId"), reason: optionalReason(after.reason) } };
    case "template_publish":
      if (body.targetUserId != null || body.targetRoleId != null) throw new ResearchApiError("VALIDATION_ERROR", "模板发布不能指定目标", 422);
      allowedKeys(before, [], "before"); allowedKeys(after, ["code", "name", "permissions", "changeSummary"], "after");
      return { changeType, applicationId, targetUserId: null, targetRoleId: null, before: {}, after: { code: limitedText(after.code, "after.code", 80), name: limitedText(after.name, "after.name", 120), permissions: parseRolePermissions(after.permissions, applicationId), changeSummary: limitedText(after.changeSummary ?? "initial", "after.changeSummary", 500) } };
    default: throw new ResearchApiError("VALIDATION_ERROR", "权限变更类型无效", 422, { fields: ["changeType"] });
  }
}
