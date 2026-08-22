import { changeAccountPassword } from "@/lib/account-password";
import { clientSelfPasswordHash } from "@/lib/client-identity-gateway";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getClientAuthPostgresPool, getPostgresPool } from "@/lib/postgres";
import { authConnectionBucketKey, clearSessionCookieHeaders } from "@/lib/riverton-apps";
import { requireCurrentSession, responseError } from "@/lib/session";
import { readResearchJson, ResearchApiError } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const current = await requireCurrentSession(request);
    const input = await readResearchJson(request, 4_096);
    const currentPassword = String(input.currentPassword ?? "");
    const newPassword = String(input.newPassword ?? "");
    if (currentPassword.length < 1 || currentPassword.length > 128) throw new ResearchApiError("CURRENT_PASSWORD_INVALID", "当前密码不正确", 422);
    if (newPassword.length < 10 || newPassword.length > 128) throw new ResearchApiError("PASSWORD_LENGTH_INVALID", "新密码须为 10–128 个字符", 422);
    const connection = authConnectionBucketKey(request);
    const clientPasswordHash = current.session.appAudience === "client"
      ? await clientSelfPasswordHash(await getClientAuthPostgresPool(), current.session.tokenHash)
      : undefined;
    if (current.session.appAudience === "client" && !clientPasswordHash) {
      throw new ResearchApiError("CURRENT_PASSWORD_INVALID", "当前密码不正确", 422);
    }
    const result = await changeAccountPassword(await getPostgresPool(), {
      userId: current.user.id,
      sessionTokenHash: current.session.appAudience === "client" ? current.session.tokenHash : undefined,
      currentPasswordHash: clientPasswordHash ?? undefined,
      currentPassword,
      newPassword,
      ipAddress: connection?.ipAddress,
      userAgent: request.headers.get("user-agent"),
    });
    if (!result.ok) {
      const message = result.code === "PASSWORD_REUSE" ? "新密码不能与当前密码相同" : "当前密码不正确";
      throw new ResearchApiError(result.code, message, 422);
    }
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const cookie of clearSessionCookieHeaders(request)) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ ok: true, sessionsRevoked: true }), { headers });
  } catch (error) { return responseError(error, request.headers.get("x-request-id") ?? undefined); }
}
