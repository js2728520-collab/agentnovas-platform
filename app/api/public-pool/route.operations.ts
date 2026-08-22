import { ApiPolicyError, apiErrorResponse, requestIdFor } from "@/lib/api-policy";

export async function GET(request: Request) {
  return apiErrorResponse(
    new ApiPolicyError(
      "ROUTE_DISABLED",
      "旧公共客户池未纳入商业 Beta，当前接口已关闭",
      503,
    ),
    requestIdFor(request),
  );
}
