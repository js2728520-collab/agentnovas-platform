import { ResearchApiError } from "@/lib/research-errors";

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
  if (error instanceof ResearchApiError) {
    return Response.json({
      error: { code: error.code, message: error.message, details: error.details },
    }, { status: error.status });
  }
  return Response.json({
    error: { code: "INTERNAL_ERROR", message: "AI 服务处理失败", details: [] },
  }, { status: 500 });
}
