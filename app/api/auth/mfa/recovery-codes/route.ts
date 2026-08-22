import { getMfaRecoveryStatus, rotateMfaRecoveryCodes } from "@/lib/mfa";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { requireCurrentSession, requireRecentMfaSession } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const current = await requireCurrentSession(request);
    return Response.json(await getMfaRecoveryStatus(await getPostgresPool(), {
      userId: current.user.id,
      sessionTokenHash: current.session.appAudience === "client" ? current.session.tokenHash : undefined,
    }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const authenticated = await requireCurrentSession(request);
    const current = authenticated.session.appAudience === "client"
      ? authenticated
      : await requireRecentMfaSession(request);
    const audience = current.session.appAudience;
    const body = await readResearchJson(request, 2_048);
    const reason = audience === "client"
      ? "Client self-service recovery code rotation"
      : typeof body.reason === "string" ? body.reason.trim() : "";
    const verificationCode = typeof body.verificationCode === "string" ? body.verificationCode.trim() : "";
    const result = await rotateMfaRecoveryCodes(await getPostgresPool(), {
      userId: current.user.id,
      sessionId: current.session.id,
      sessionTokenHash: audience === "client" ? current.session.tokenHash : undefined,
      audience,
      reason,
      verificationCode,
    });
    if (!result.ok) {
      const message = result.code === "NOT_ENROLLED"
        ? "双重验证尚未启用"
        : result.code === "VERIFICATION_INVALID" ? "动态验证码或恢复码无效、已使用或已过期" : "轮换原因需要 3–500 个字符";
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
