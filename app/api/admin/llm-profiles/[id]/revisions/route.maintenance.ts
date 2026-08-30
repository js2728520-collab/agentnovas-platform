import {
  listLlmProfileRevisions,
  rollbackCompatibilityLlmProfileRevision,
} from "@/lib/ai-control-plane-compatibility";
import { requireAccessPermission, requireAnyAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { automaticAuditReason, maintenanceCorrelation } from "@/lib/maintenance-audit";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAnyAccessPermission(request, ["maint.system_health.view", "maint.llm_profiles.manage"]);
    const { id } = await params;
    const revisions = await listLlmProfileRevisions(await getPostgresPool(), id);
    if (!revisions.length) throw new ResearchApiError("MODEL_PROFILE_NOT_FOUND", "模型 Profile 不存在", 404);
    return Response.json({ revisions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.llm_profiles.manage");
    const { id } = await params;
    const body = await readResearchJson(request, 4_096);
    const revisionId = typeof body.revisionId === "string" ? body.revisionId : "";
    const expectedCurrentRevisionId = typeof body.expectedCurrentRevisionId === "string" ? body.expectedCurrentRevisionId : "";
    const reason = automaticAuditReason("ai_control_plane.legacy_profile.rollback");
    if (!revisionId || !expectedCurrentRevisionId) throw new ResearchApiError("MODEL_ROLLBACK_INVALID", "目标修订和当前修订快照均为必填", 422);
    const result = await rollbackCompatibilityLlmProfileRevision(await getPostgresPool(), {
      profileId: id,
      revisionId,
      expectedCurrentRevisionId,
      actorUserId: user.id,
      reason,
      requestId: maintenanceCorrelation(request).requestId ?? crypto.randomUUID(),
    });
    return Response.json({ ...result, message: result.replayed ? "目标修订已经是当前版本" : "模型 Profile 已回滚为新的不可变修订" });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
