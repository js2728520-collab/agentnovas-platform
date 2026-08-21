import { currentUser, type CurrentUser } from "./session.ts";
import { ResearchApiError } from "./research-errors.ts";

export { ResearchApiError } from "./research-errors.ts";
export { researchErrorResponse } from "./research-error-response.ts";

export async function requireResearchUser(request: Request, roles?: CurrentUser["role"][]) {
  const user = await currentUser(request);
  if (!user) throw new ResearchApiError("AUTH_REQUIRED", "请先登录", 401);
  if (roles && !roles.includes(user.role)) throw new ResearchApiError("FORBIDDEN", "无权执行此操作", 403);
  return user;
}

export async function readResearchJson(request: Request, maximumBytes = 32_768) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ResearchApiError("REQUEST_TOO_LARGE", "请求体过大", 413, { maximumBytes });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ResearchApiError("REQUEST_TOO_LARGE", "请求体过大", 413, { maximumBytes });
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new ResearchApiError("INVALID_JSON", "请求 JSON 必须是对象", 400);
  }
}
