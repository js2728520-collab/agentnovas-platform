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
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
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
