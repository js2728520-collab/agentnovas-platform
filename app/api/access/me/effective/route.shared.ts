import { effectiveAccessForUser } from "@/lib/access-control";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { requireUser, responseError } from "@/lib/session";
import { resolveAppAudience } from "@/lib/riverton-apps";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(request);
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
    return responseError(error);
  }
}
