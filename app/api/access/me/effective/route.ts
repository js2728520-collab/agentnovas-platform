import { effectiveAccessForUser } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { currentSession } from "@/lib/session";
import { resolveAppAudience } from "@/lib/riverton-apps";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const current = await currentSession(request);
    if (!current) throw new ResearchApiError("AUTH_REQUIRED", "请先登录", 401);
    const { user } = current;
    const appId = resolveAppAudience({ host: request.headers.get("host") ?? undefined });
    const pool = await getPostgresPool();
    const access = await effectiveAccessForUser(pool, user, appId);
    return Response.json({
      appId,
      source: access.source,
      user: {
        id: user.id,
        role: user.role,
        organizationId: user.organizationId,
      },
      permissions: access.permissions,
    }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
