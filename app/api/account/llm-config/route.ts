import { ApiPolicyError, apiErrorResponse, requestIdFor } from "../../../../lib/api-policy.ts";

function clientByokDisabled(request: Request) {
  return apiErrorResponse(
    new ApiPolicyError(
      "ROUTE_DISABLED",
      "当前 Beta 统一使用平台模型，不接受客户自带 API Key 或私有端点",
      503,
    ),
    requestIdFor(request),
  );
}

export async function GET(request: Request) {
  return clientByokDisabled(request);
}

export async function PUT(request: Request) {
  return clientByokDisabled(request);
}
