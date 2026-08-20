import { NextResponse, type NextRequest } from "next/server";

import { apiErrorResponse, evaluateApiRequestPolicy, requestIdFor } from "@/lib/api-policy";

export function proxy(request: NextRequest) {
  let requestId = requestIdFor(request);
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
  matcher: "/api/:path*",
};
