import { NextResponse, type NextRequest } from "next/server";

import { ApiPolicyError, apiErrorResponse, evaluateApiRequestPolicy, requestIdFor } from "@/lib/api-policy";
import { contentSecurityPolicy, createCspNonce } from "@/lib/content-security-policy";
import { resolveAppAudienceStrict } from "@/lib/riverton-apps";

export function proxy(request: NextRequest) {
  let requestId = requestIdFor(request);
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    const audience = resolveAppAudienceStrict({ host: request.headers.get("host") ?? request.nextUrl.host });
    if (!audience) return apiErrorResponse(
      new ApiPolicyError("UNKNOWN_AUDIENCE", "当前域名未配置应用", 404),
      requestId,
    );
    const nonce = createCspNonce();
    const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV !== "production");
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-request-id", requestId);
    requestHeaders.set("x-riverton-app-audience", audience);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", policy);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("content-security-policy", policy);
    response.headers.set("x-request-id", requestId);
    return response;
  }
  try {
    const context = evaluateApiRequestPolicy(request);
    requestId = context.requestId;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-request-id", requestId);
    requestHeaders.set("x-riverton-app-audience", context.audience);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
