import { hashPassword, sha256 } from "@/lib/auth";
import { consumePasswordReset } from "@/lib/password-reset";
import { getPostgresPool } from "@/lib/postgres";
export async function POST(request: Request) {
  try {
    const { token = "", password = "" } = await request.json() as { token?: string; password?: string };
    const result = await consumePasswordReset(await getPostgresPool(), {
      tokenHash: await sha256(token),
      passwordHash: await hashPassword(password),
    });
    if (!result.ok) return Response.json({ error: "重置链接无效或已过期" }, { status: 400 });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "重置失败" }, { status: 400 });
  }
}
