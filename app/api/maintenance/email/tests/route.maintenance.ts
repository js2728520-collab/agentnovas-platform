import { requireAccessPermission } from "@/lib/access-control";
import { listEmailTestHistory } from "@/lib/email-service-management";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "maint.email_integrations.manage");
    let result;
    try {
      result = await listEmailTestHistory(await getPostgresPool(), {
        viewerUserId: user.id,
        limit: new URL(request.url).searchParams.get("limit"),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "EMAIL_TEST_HISTORY_LIMIT_INVALID") {
        throw new ResearchApiError(error.message, "邮件测试记录数量无效", 422);
      }
      throw error;
    }
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
