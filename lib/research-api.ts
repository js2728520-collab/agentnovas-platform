import { currentUser, type CurrentUser } from "./session";

export class ResearchApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ResearchApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

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

export function researchErrorResponse(error: unknown) {
  if (error instanceof ResearchApiError) {
    return Response.json({
      error: { code: error.code, message: error.message, details: error.details },
    }, { status: error.status });
  }
  if (error instanceof Error && /尚未配置/.test(error.message)) {
    return Response.json({
      error: { code: "SERVICE_NOT_CONFIGURED", message: error.message, details: {} },
    }, { status: 503 });
  }
  return Response.json({
    error: { code: "INTERNAL_ERROR", message: "策略研发服务处理失败", details: {} },
  }, { status: 500 });
}
