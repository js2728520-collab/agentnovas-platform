import { getMfaRecoveryStatus, rotateMfaRecoveryCodes } from "@/lib/mfa";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { requireCurrentSession, requireRecentMfaSession } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const current = await requireCurrentSession(request);
    if (current.session.appAudience === "client") throw new ResearchApiError("ROUTE_NOT_AVAILABLE", "当前应用不提供内部双重验证", 404);
    return Response.json(await getMfaRecoveryStatus(await getPostgresPool(), { userId: current.user.id }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const current = await requireRecentMfaSession(request);
    const audience = current.session.appAudience;
    if (audience !== "operations" && audience !== "maintenance") throw new ResearchApiError("ROUTE_NOT_AVAILABLE", "当前应用不提供内部双重验证", 404);
    const body = await readResearchJson(request, 2_048);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const result = await rotateMfaRecoveryCodes(await getPostgresPool(), {
      userId: current.user.id,
      sessionId: current.session.id,
      audience,
      reason,
    });
    if (!result.ok) {
      const message = result.code === "NOT_ENROLLED" ? "双重验证尚未启用" : "轮换原因需要 3–500 个字符";
      throw new ResearchApiError(result.code, message, 422);
    }
    return Response.json({
      ok: true,
      recoveryCodes: result.recoveryCodes,
      warning: "恢复码仅显示这一次，请立即保存到受控密码管理器；旧的未使用恢复码已经失效。",
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
