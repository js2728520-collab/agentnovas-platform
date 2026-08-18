import {
  bindRuntimeExplanationRole,
  listRuntimeExplanationBindings,
} from "@/lib/agent-model-profiles";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import {
  readResearchJson,
  requireResearchUser,
  researchErrorResponse,
} from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireResearchUser(request, ["hq_admin"]);
    const pool = await getPostgresPool();
    return Response.json({
      bindings: await listRuntimeExplanationBindings(pool, { visibility: "administrator" }),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["hq_admin"]);
    const body = await readResearchJson(request);
    const pool = await getPostgresPool();
    const binding = await bindRuntimeExplanationRole(pool, {
      actorUserId: user.id,
      role: String(body.role ?? ""),
      profileId: String(body.profileId ?? ""),
      enabled: body.enabled !== false,
    });
    return Response.json({ binding });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
