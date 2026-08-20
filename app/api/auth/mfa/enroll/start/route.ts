import { startMfaEnrollment } from "@/lib/mfa";
import { getPostgresPool } from "@/lib/postgres";
import { requirePrimarySession, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    const current = await requirePrimarySession(request);
    if (current.session.appAudience === "client") return Response.json({ error: "当前应用不提供内部双重验证" }, { status: 404 });
    const assignment = await (await getPostgresPool()).query(`
      SELECT 1 FROM user_role_assignments
      WHERE user_id = $1 AND application_id = $2 AND status = 'active'
        AND effective_at <= now() AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `, [current.user.id, current.session.appAudience]);
    if (!assignment.rowCount) return Response.json({ error: "当前内部账号没有有效显式授权" }, { status: 403 });
    const result = await startMfaEnrollment(await getPostgresPool(), { userId: current.user.id });
    if (!result.ok) return Response.json({ error: "双重验证已经配置" }, { status: 409 });
    const issuer = encodeURIComponent("Riverton Capital");
    const label = encodeURIComponent(`Riverton Capital:${current.user.email}`);
    return Response.json({
      otpauthUri: `otpauth://totp/${label}?secret=${result.secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
      message: "请扫描二维码并输入一次动态验证码完成绑定",
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}
