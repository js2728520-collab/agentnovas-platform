type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type WorkerType = "research" | "runtime" | "notification" | "payment" | "demo_execution";
export type WorkerRuntimeStatus = "starting" | "running" | "stopping" | "stopped" | "error";
export type WorkerLiveness = "missing" | "alive" | "stale";
export type WorkerHealthState = "disabled" | "unconfigured" | "missing" | "stale" | "degraded" | "healthy";

const DEFAULT_STALE_AFTER_MS = 60_000;

function boundedBooleanMetadata(value: Record<string, unknown> | undefined) {
  const metadata: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value ?? {}).slice(0, 20)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) && typeof entry === "boolean") metadata[key] = entry;
  }
  return metadata;
}

export function classifyWorkerHeartbeat(
  now: Date,
  heartbeatAt: Date | string | null,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): WorkerLiveness {
  if (!heartbeatAt) return "missing";
  const timestamp = heartbeatAt instanceof Date ? heartbeatAt.getTime() : new Date(heartbeatAt).getTime();
  if (!Number.isFinite(timestamp)) return "missing";
  return now.getTime() - timestamp < staleAfterMs ? "alive" : "stale";
}

export function deriveWorkerHealthState(input: {
  configured: boolean;
  enabled: boolean;
  liveness: WorkerLiveness;
  runtimeStatus: WorkerRuntimeStatus | null;
}): WorkerHealthState {
  if (!input.enabled) return "disabled";
  if (!input.configured) return "unconfigured";
  if (input.liveness === "missing") return "missing";
  if (input.liveness === "stale") return "stale";
  return input.runtimeStatus === "running" ? "healthy" : "degraded";
}

export function normalizeWorkerErrorCode(value: unknown) {
  const normalized = String(value || "UNKNOWN")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "UNKNOWN";
}

export async function recordWorkerHeartbeat(database: Queryable, input: {
  workerType: WorkerType;
  instanceId: string;
  commitSha?: string | null;
  status: WorkerRuntimeStatus;
  now?: Date;
  currentJobId?: string | null;
  lastSuccessAt?: Date | null;
  lastFailureAt?: Date | null;
  lastErrorCode?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const now = input.now ?? new Date();
  const instanceId = input.instanceId.trim().slice(0, 160);
  if (!instanceId) throw new Error("Worker instance id is required");
  const errorCode = input.lastErrorCode ? normalizeWorkerErrorCode(input.lastErrorCode) : null;
  await database.query(`
    INSERT INTO worker_instances (
      worker_type, instance_id, commit_sha, status, started_at, heartbeat_at,
      last_success_at, last_failure_at, last_error_code, current_job_id, metadata_json, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10::jsonb, $5)
    ON CONFLICT (worker_type, instance_id) DO UPDATE SET
      commit_sha = COALESCE(EXCLUDED.commit_sha, worker_instances.commit_sha),
      status = EXCLUDED.status,
      heartbeat_at = EXCLUDED.heartbeat_at,
      last_success_at = COALESCE(EXCLUDED.last_success_at, worker_instances.last_success_at),
      last_failure_at = COALESCE(EXCLUDED.last_failure_at, worker_instances.last_failure_at),
      last_error_code = CASE
        WHEN EXCLUDED.last_failure_at IS NOT NULL THEN EXCLUDED.last_error_code
        ELSE worker_instances.last_error_code
      END,
      current_job_id = EXCLUDED.current_job_id,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = EXCLUDED.updated_at
  `, [
    input.workerType,
    instanceId,
    input.commitSha?.trim().slice(0, 80) || null,
    input.status,
    now.toISOString(),
    input.lastSuccessAt?.toISOString() || null,
    input.lastFailureAt?.toISOString() || null,
    errorCode,
    input.currentJobId?.trim().slice(0, 160) || null,
    JSON.stringify(boundedBooleanMetadata(input.metadata)),
  ]);
}

export function createWorkerHeartbeatReporter(database: Queryable, input: {
  workerType: WorkerType;
  instanceId: string;
  commitSha?: string | null;
  intervalMs?: number;
  metadata?: Record<string, unknown>;
  onError?: (error: unknown) => void;
}) {
  const intervalMs = Math.max(5_000, Math.min(input.intervalMs ?? 15_000, 30_000));
  let currentJobId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let writeInFlight = false;

  const write = async (overrides: Partial<Parameters<typeof recordWorkerHeartbeat>[1]> = {}) => {
    if (writeInFlight) return;
    writeInFlight = true;
    try {
      await recordWorkerHeartbeat(database, {
        workerType: input.workerType,
        instanceId: input.instanceId,
        commitSha: input.commitSha,
        metadata: input.metadata,
        status: stopped ? "stopped" : "running",
        currentJobId,
        ...overrides,
      });
    } catch (error) {
      input.onError?.(error);
    } finally {
      writeInFlight = false;
    }
  };

  return {
    async start() {
      stopped = false;
      await write({ status: "starting" });
      timer = setInterval(() => { void write(); }, intervalMs);
      timer.unref?.();
    },
    setCurrentJob(jobId: string | null) {
      currentJobId = jobId?.trim().slice(0, 160) || null;
    },
    async markSuccess(now = new Date()) {
      currentJobId = null;
      await write({ status: "running", lastSuccessAt: now });
    },
    async markFailure(error: unknown, now = new Date()) {
      currentJobId = null;
      const code = error instanceof Error ? error.name : error;
      await write({ status: "error", lastFailureAt: now, lastErrorCode: normalizeWorkerErrorCode(code) });
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await write({ status: "stopped", currentJobId: null });
    },
  };
}

export async function loadWorkerDiagnostics(database: Queryable, now = new Date()) {
  const result = await database.query(`
    SELECT DISTINCT ON (worker_type)
      worker_type, instance_id, commit_sha, status, started_at, heartbeat_at,
      last_success_at, last_failure_at, last_error_code, current_job_id
    FROM worker_instances
    ORDER BY worker_type, heartbeat_at DESC
  `);
  return result.rows.map((row) => ({
    workerType: String(row.worker_type),
    instanceId: String(row.instance_id),
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    configuredStatus: String(row.status),
    liveness: classifyWorkerHeartbeat(now, row.heartbeat_at as Date | string | null),
    startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at as string).toISOString() : null,
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at as string).toISOString() : null,
    lastFailureAt: row.last_failure_at ? new Date(row.last_failure_at as string).toISOString() : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    currentJobId: row.current_job_id ? String(row.current_job_id) : null,
  }));
}
