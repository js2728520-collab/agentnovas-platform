import { ApiPolicyError, apiErrorResponse, requestIdFor } from "@/lib/api-policy";

export async function GET(request: Request) {
  return apiErrorResponse(
    new ApiPolicyError(
      "ROUTE_DISABLED",
      "客户侧集成目录在当前 Beta 未开放，请由运维端管理平台集成",
      503,
    ),
    requestIdFor(request),
  );
}
