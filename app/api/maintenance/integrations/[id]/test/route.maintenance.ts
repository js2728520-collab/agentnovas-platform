import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import { automaticAuditReason, maintenanceCorrelation } from "@/lib/maintenance-audit";
import { runIdempotentMaintenanceSourceIntegrationCheck } from "@/lib/maintenance-integration-catalog";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "maint.feature_flags.manage");
    const { id } = await params;
    await readResearchJson(request, 4_096);
    const reason = automaticAuditReason("maintenance.source_integration.test");
    let result;
    try {
      result = await runIdempotentMaintenanceSourceIntegrationCheck(await getPostgresPool(), {
        id,
        actorUserId: user.id,
        reason,
        idempotencyKey: idempotencyKey(request),
        ...maintenanceCorrelation(request),
      });
    } catch (error) {
      if (error instanceof ResearchApiError) throw error;
      const code = error instanceof Error ? error.message : "INTEGRATION_TEST_FAILED";
      const mapped = code === "INTEGRATION_NOT_FOUND" ? ["集成不存在", 404] : code === "INTEGRATION_TEST_UNAVAILABLE" ? ["该集成尚未接入安全测试", 503] : ["集成测试执行失败", 502];
      throw new ResearchApiError(code, mapped[0] as string, mapped[1] as number);
    }
    if (result.terminalStatus !== "succeeded") {
      const response = result.response as { checkedAt?: string; latencyMs?: number };
      throw new ResearchApiError(
        result.errorCode ?? "INTEGRATION_TEST_FAILED",
        result.errorCode === "MAINTENANCE_RECONCILIATION_REQUIRED" ? "上一次测试结果未知，需要人工核对，系统未重复调用外部服务" : "集成测试未通过",
        result.responseStatus,
        { checkedAt: response.checkedAt, latencyMs: response.latencyMs, replayed: result.replayed },
      );
    }
    return Response.json(result.response, { headers: { "idempotency-replayed": String(result.replayed) } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
