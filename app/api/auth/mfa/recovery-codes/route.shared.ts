import { getMfaRecoveryStatus, mfaEnforcementEnabled, rotateMfaRecoveryCodes } from "@/lib/mfa";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { requireCurrentSession, requireRecentMfaSession } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const current = await requireCurrentSession(request);
    const status = await getMfaRecoveryStatus(await getPostgresPool(), {
      userId: current.user.id,
      sessionTokenHash: current.session.appAudience === "client" ? current.session.tokenHash : undefined,
    });
    return Response.json({ ...status, enforcementEnabled: mfaEnforcementEnabled() }, {
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
    const reason = automaticAuditReason("shared.account.mfa.recovery_codes.rotate");
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
      if (result.code === "REASON_INVALID") {
        throw new ResearchApiError("AUTOMATIC_AUDIT_ACTION_INVALID", "自动审计标记无效", 500);
      }
      const message = result.code === "NOT_ENROLLED"
        ? "双重验证尚未启用"
        : "动态验证码或恢复码无效、已使用或已过期";
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
