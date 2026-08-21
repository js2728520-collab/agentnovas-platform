import { ApiPolicyError, apiErrorResponse, requestIdFor } from "../../../../../lib/api-policy.ts";

export async function POST(request: Request) {
  return apiErrorResponse(
    new ApiPolicyError(
      "ROUTE_DISABLED",
      "当前 Beta 已关闭客户私有模型连通测试",
      503,
    ),
    requestIdFor(request),
  );
}
