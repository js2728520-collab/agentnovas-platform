import { requireAccessPermission } from "@/lib/access-control";
import { verifyPlatformDemoAccount } from "@/lib/platform-demo-execution";
import { getPostgresPool } from "@/lib/postgres";
import {
  readResearchJson,
  ResearchApiError,
  researchErrorResponse,
} from "@/lib/research-api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAccessPermission(
      request,
      "maint.demo_exchanges.verify",
    );
    if (process.env.PLATFORM_DEMO_VERIFICATION_ENABLED !== "true") {
      throw new ResearchApiError(
        "DEMO_VERIFICATION_DISABLED",
        "Demo provider 连通验证未获环境授权，未发起外部请求",
        503,
      );
    }
    const body = await readResearchJson(request, 4_096);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 8 || reason.length > 500) {
      throw new ResearchApiError("VALIDATION_ERROR", "reason 需为 8 到 500 个字符", 422, {
        fields: ["reason"],
      });
    }
    const { id } = await params;
    const result = await verifyPlatformDemoAccount(await getPostgresPool(), {
      accountId: id,
      actorId: user.id,
    });
    return Response.json({
      ok: true,
      accountId: result.accountId,
      provider: result.provider,
      status: result.status,
      verifiedAt: result.verifiedAt,
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
