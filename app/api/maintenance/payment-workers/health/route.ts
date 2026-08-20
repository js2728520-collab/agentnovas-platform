import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { demoExecutionWorkerConfig } from "@/lib/demo-worker-config";
import {
  deriveWorkerHealthState,
  loadWorkerDiagnostics,
  type WorkerLiveness,
  type WorkerRuntimeStatus,
  type WorkerType,
} from "@/lib/worker-observability";

type WorkerDiagnostic = Awaited<ReturnType<typeof loadWorkerDiagnostics>>[number];

function workerStatus(
  diagnostics: Map<string, WorkerDiagnostic>,
  workerType: WorkerType,
  input: { configured: boolean; enabled: boolean },
) {
  const latest = diagnostics.get(workerType);
  const liveness = (latest?.liveness ?? "missing") as WorkerLiveness;
  const runtimeStatus = (latest?.configuredStatus ?? null) as WorkerRuntimeStatus | null;
  return {
    configured: input.configured,
    enabled: input.enabled,
    liveness,
    health: deriveWorkerHealthState({
      configured: input.configured,
      enabled: input.enabled,
      liveness,
      runtimeStatus,
    }),
    runtimeStatus,
    heartbeatAt: latest?.heartbeatAt ?? null,
    lastSuccessAt: latest?.lastSuccessAt ?? null,
    lastFailureAt: latest?.lastFailureAt ?? null,
    lastErrorCode: latest?.lastErrorCode ?? null,
    currentJobId: latest?.currentJobId ?? null,
    commitSha: latest?.commitSha ?? null,
  };
}

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "maint.system_health.view");
    const pool = await getPostgresPool();
    await pool.query("SELECT 1");
    const diagnostics = new Map(
      (await loadWorkerDiagnostics(pool)).map((diagnostic) => [diagnostic.workerType, diagnostic]),
    );
    const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());
    const demoWorkerConfig = demoExecutionWorkerConfig();
    const response = {
      checkedAt: new Date().toISOString(),
      database: { status: "ready" },
      paymentWorker: workerStatus(diagnostics, "payment", {
        configured: databaseConfigured,
        enabled: process.env.PAYMENT_WORKER_ENABLED === "true",
      }),
      notificationWorker: {
        ...workerStatus(diagnostics, "notification", {
          configured: databaseConfigured && Boolean(process.env.RESEND_API_KEY?.trim()),
          enabled: process.env.NOTIFICATION_WORKER_ENABLED === "true",
        }),
        resendConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
      },
      researchWorker: workerStatus(diagnostics, "research", {
        configured: databaseConfigured,
        enabled: process.env.STRATEGY_RESEARCH_ENABLED === "true",
      }),
      runtimeWorker: workerStatus(diagnostics, "runtime", {
        configured: databaseConfigured,
        enabled: process.env.STRATEGY_RUNTIME_ENABLED === "true",
      }),
      demoExecutionWorker: {
        ...workerStatus(diagnostics, "demo_execution", {
          configured: databaseConfigured && Boolean(process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY?.trim()),
          enabled: demoWorkerConfig.processEnabled,
        }),
        externalWritesEnabled: demoWorkerConfig.externalWritesEnabled,
        executionEnabled: demoWorkerConfig.executionEnabled,
      },
    };
    return Response.json(response, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
