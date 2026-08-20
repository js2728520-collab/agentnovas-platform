import { changeAccountPassword } from "@/lib/account-password";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { authConnectionBucketKey, clearSessionCookieHeaders } from "@/lib/riverton-apps";
import { requireUser, responseError } from "@/lib/session";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const current = await requireUser(request);
    const input = await request.json() as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = String(input.currentPassword ?? "");
    const newPassword = String(input.newPassword ?? "");
    const connection = authConnectionBucketKey(request);
    const result = await changeAccountPassword(await getPostgresPool(), {
      userId: current.id,
      currentPassword,
      newPassword,
      ipAddress: connection?.ipAddress,
      userAgent: request.headers.get("user-agent"),
    });
    if (!result.ok) {
      const message = result.code === "PASSWORD_REUSE" ? "新密码不能与当前密码相同" : "当前密码不正确";
      return Response.json({ error: message }, { status: 400 });
    }
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const cookie of clearSessionCookieHeaders(request)) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ ok: true, sessionsRevoked: true }), { headers });
  } catch (error) { return responseError(error); }
}
