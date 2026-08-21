import { normalizeRequestId, requestIdFor } from "./api-policy.ts";
import { ResearchApiError } from "./research-errors.ts";

function responseRequestId(source?: Request | string) {
  if (source instanceof Request) return requestIdFor(source);
  return normalizeRequestId(source) ?? crypto.randomUUID();
}

export function researchErrorResponse(error: unknown, requestOrId?: Request | string) {
  const requestId = responseRequestId(requestOrId);
  let status = 500;
  let body: { error: { code: string; message: string; details?: unknown }; requestId: string };
  if (error instanceof ResearchApiError) {
    status = error.status;
    body = {
      error: { code: error.code, message: error.message, details: error.details },
      requestId,
    };
  } else if (error instanceof Response && error.status >= 400 && error.status <= 599) {
    status = error.status;
    const code = status === 401 ? "AUTH_REQUIRED"
      : status === 403 ? "FORBIDDEN"
        : status === 404 ? "NOT_FOUND"
          : "REQUEST_REJECTED";
    const message = status === 401 ? "请先登录"
      : status === 403 ? "无权执行此操作"
        : status === 404 ? "请求的资源不存在"
          : "请求未被接受";
    body = { error: { code, message }, requestId };
  } else {
    body = {
      error: { code: "INTERNAL_ERROR", message: "策略研发服务处理失败", details: {} },
      requestId,
    };
  }
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });
}
