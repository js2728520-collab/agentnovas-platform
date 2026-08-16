import { currentUser, type CurrentUser } from "@/lib/session";

export class AiApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown[];

  constructor(code: string, message: string, status: number, details: unknown[] = []) {
    super(message);
    this.name = "AiApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function requireAiCustomer(request: Request): Promise<CurrentUser> {
  const user = await currentUser(request);
  if (!user) throw new AiApiError("AUTH_REQUIRED", "请先登录", 401);
  if (user.role !== "customer") throw new AiApiError("FORBIDDEN", "无权使用客户 AI 助手", 403);
  return user;
}

export async function readAiJson(request: Request) {
  const maximumBytes = 32_768;
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new AiApiError("REQUEST_TOO_LARGE", "AI 请求体不能超过 32KB", 413);
  }
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      throw new AiApiError("REQUEST_TOO_LARGE", "AI 请求体不能超过 32KB", 413);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AiApiError("INVALID_JSON", "请求 JSON 必须是对象", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AiApiError) throw error;
    throw new AiApiError("INVALID_JSON", "请求 JSON 格式无效", 400);
  }
}

export function aiErrorResponse(error: unknown) {
  if (error instanceof AiApiError) {
    return Response.json({
      error: { code: error.code, message: error.message, details: error.details },
    }, { status: error.status });
  }
  return Response.json({
    error: { code: "INTERNAL_ERROR", message: "AI 服务处理失败", details: [] },
  }, { status: 500 });
}
