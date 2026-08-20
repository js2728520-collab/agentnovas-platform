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
