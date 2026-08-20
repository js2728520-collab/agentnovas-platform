import { API_ROUTE_INVENTORY, type ApiRouteInventoryEntry } from "./api-route-inventory.ts";
import { resolveAppAudienceStrict, type AppAudience } from "./riverton-apps.ts";

export type ApiAuthentication = "anonymous" | "session" | "permission" | "webhook" | "bootstrap";

export type ApiRoutePolicy = {
  audiences: readonly AppAudience[];
  authentication: ApiAuthentication;
  permissionKeys: readonly string[];
  scope: "none" | "grant" | "platform";
  mfa: "none" | "recent";
  pii: "none" | "masked" | "full";
  sensitivity: "normal" | "sensitive";
  requiresSameOrigin: boolean;
  sensitive: boolean;
};

export type ApiRequestContext = {
  requestId: string;
  audience: AppAudience;
  method: string;
  pathname: string;
  inventory: ApiRouteInventoryEntry;
  policy: ApiRoutePolicy;
};

export class ApiPolicyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiPolicyError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function routeMatches(pattern: string, pathname: string) {
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index];
    if (part.startsWith(":") && part.endsWith("*")) return actual.length >= index;
    if (actual[index] === undefined) return false;
    if (!part.startsWith(":") && part !== actual[index]) return false;
  }
  return actual.length === expected.length;
}

function routeSpecificity(route: string) {
  return route.split("/").reduce((score, part) => score + (part.startsWith(":") ? 0 : 1), 0);
}

export function findApiRouteInventory(method: string, pathname: string): ApiRouteInventoryEntry | null {
  const normalizedMethod = method.toUpperCase();
  const candidates = API_ROUTE_INVENTORY
    .filter((entry) => entry.method === normalizedMethod && routeMatches(entry.route, pathname))
    .sort((left, right) => routeSpecificity(right.route) - routeSpecificity(left.route));
  return candidates[0] ?? null;
}

export function apiPolicyForRoute(route: string, method: string): ApiRoutePolicy {
  const entry = API_ROUTE_INVENTORY.find((candidate) => candidate.route === route && candidate.method === method.toUpperCase());
  if (!entry) throw new ApiPolicyError("POLICY_NOT_REGISTERED", "接口安全策略尚未注册", 404, { route, method });
  return {
    audiences: entry.audiences,
    authentication: entry.authentication,
    permissionKeys: entry.permissionKeys,
    scope: entry.scope,
    mfa: entry.mfa,
    pii: entry.pii,
    sensitivity: entry.sensitivity,
    requiresSameOrigin: entry.requiresSameOrigin,
    sensitive: entry.sensitivity === "sensitive",
  };
}

export function normalizeRequestId(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{8,128}$/.test(normalized) ? normalized : null;
}

export function requestIdFor(request: Request) {
  return normalizeRequestId(request.headers.get("x-request-id")) ?? crypto.randomUUID();
}

function trustedForwardedHeader(request: Request, name: string) {
  const trustedHops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(trustedHops) || trustedHops < 1 || trustedHops > 8) return null;
  const values = (request.headers.get(name) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return values.at(Math.max(0, values.length - trustedHops)) ?? null;
}

function expectedRequestOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedProtocol = trustedForwardedHeader(request, "x-forwarded-proto");
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http"
    ? `${forwardedProtocol}:`
    : url.protocol;
  const directHost = request.headers.get("host")?.trim() || url.host;
  return new URL(`${protocol}//${directHost}`).origin;
}

export function assertSameOrigin(request: Request) {
  const supplied = request.headers.get("origin")?.trim();
  if (!supplied || supplied === "null") {
    throw new ApiPolicyError("CSRF_ORIGIN_REQUIRED", "缺少同源请求证明", 403);
  }
  let normalized: string;
  try {
    const origin = new URL(supplied);
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("invalid origin");
    normalized = origin.origin;
  } catch {
    throw new ApiPolicyError("CSRF_ORIGIN_INVALID", "同源请求证明无效", 403);
  }
  if (normalized !== expectedRequestOrigin(request)) {
    throw new ApiPolicyError("CSRF_ORIGIN_MISMATCH", "拒绝跨站请求", 403);
  }
}

export function evaluateApiRequestPolicy(request: Request): ApiRequestContext {
  const url = new URL(request.url);
  const requestId = requestIdFor(request);
  const audience = resolveAppAudienceStrict({ host: request.headers.get("host") ?? url.host });
  if (!audience) throw new ApiPolicyError("UNKNOWN_AUDIENCE", "接口在当前应用不可用", 404);
  const inventory = findApiRouteInventory(request.method, url.pathname);
  if (!inventory) throw new ApiPolicyError("ROUTE_NOT_REGISTERED", "接口在当前应用不可用", 404);
  const policy = apiPolicyForRoute(inventory.route, inventory.method);
  if (!policy.audiences.includes(audience)) {
    throw new ApiPolicyError("ROUTE_NOT_AVAILABLE", "接口在当前应用不可用", 404);
  }
  if (policy.requiresSameOrigin) assertSameOrigin(request);
  return { requestId, audience, method: inventory.method, pathname: url.pathname, inventory, policy };
}

export function apiErrorResponse(error: unknown, requestId = crypto.randomUUID()) {
  const normalizedRequestId = normalizeRequestId(requestId) ?? crypto.randomUUID();
  const known = error instanceof ApiPolicyError;
  const body = {
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "服务器处理失败",
      ...(known && error.details ? { details: error.details } : {}),
    },
    requestId: normalizedRequestId,
  };
  return Response.json(body, {
    status: known ? error.status : 500,
    headers: {
      "cache-control": "no-store",
      "x-request-id": normalizedRequestId,
    },
  });
}

type PolicyHandler<Args extends unknown[]> = (
  request: Request,
  apiContext: ApiRequestContext,
  ...args: Args
) => Response | Promise<Response>;

export function withApiPolicy<Args extends unknown[]>(handler: PolicyHandler<Args>) {
  return async (request: Request, ...args: Args) => {
    let requestId = requestIdFor(request);
    try {
      const context = evaluateApiRequestPolicy(request);
      requestId = context.requestId;
      const response = await handler(request, context, ...args);
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      return apiErrorResponse(error, requestId);
    }
  };
}
