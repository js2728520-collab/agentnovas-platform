import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { researchErrorResponse } from "@/lib/research-api";
import { demoExecutionWorkerConfig } from "@/lib/demo-worker-config";
import { loadMaintenanceHealthMetrics } from "@/lib/maintenance-health-metrics";
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
    const notificationMetadata = diagnostics.get("notification")?.metadata ?? {};
    const resendConfigured = notificationMetadata.apiKeyPresent === true;
    const [queues, migration] = await Promise.all([
      loadMaintenanceHealthMetrics(pool),
      pool.query<{ name: string; checksum: string | null; commit_sha: string | null }>(
        `SELECT name,checksum,commit_sha FROM _agentnovas_migrations ORDER BY name DESC LIMIT 1`,
      ),
    ]);
    const response = {
      checkedAt: new Date().toISOString(),
      release: {
        version: process.env.RIVERTON_RELEASE_TAG?.trim() || null,
        commitSha: (process.env.GIT_COMMIT_SHA || process.env.RIVERTON_COMMIT_SHA)?.trim() || null,
      },
      database: {
        status: "ready",
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        migration: migration.rows[0] ? {
          latest: migration.rows[0].name,
          checksumRecorded: Boolean(migration.rows[0].checksum),
          commitRecorded: Boolean(migration.rows[0].commit_sha),
        } : null,
      },
      queues,
      paymentWorker: workerStatus(diagnostics, "payment", {
        configured: databaseConfigured,
        enabled: process.env.PAYMENT_WORKER_ENABLED === "true",
      }),
      notificationWorker: {
        ...workerStatus(diagnostics, "notification", {
          configured: databaseConfigured && resendConfigured,
          enabled: process.env.NOTIFICATION_WORKER_ENABLED === "true",
        }),
        resendConfigured,
      },
      researchWorker: workerStatus(diagnostics, "research", {
        configured: databaseConfigured,
        enabled: false,
      }),
      runtimeWorker: workerStatus(diagnostics, "runtime", {
        configured: databaseConfigured,
        enabled: process.env.STRATEGY_RUNTIME_ENABLED === "true",
      }),
      configurationActivationWorker: workerStatus(diagnostics, "configuration_activation", {
        configured: databaseConfigured,
        enabled: process.env.CONFIGURATION_ACTIVATION_WORKER_ENABLED === "true",
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
