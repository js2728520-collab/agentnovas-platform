import type { Pool, PoolClient } from "pg";

import { normalizeWorkerErrorCode } from "./worker-observability.ts";

export const CONFIGURATION_ACTIVATION_WORKER_LEASE_KEY = "configuration-activation-worker:global";

export type ConfigurationActivationWorkerResult = {
  leaseAcquired: boolean;
  scanned: number;
  activated: number;
  skipped: number;
  failed: number;
  failures: Array<{ versionId: string; code: string }>;
};

function emptyResult(leaseAcquired: boolean): ConfigurationActivationWorkerResult {
  return { leaseAcquired, scanned: 0, activated: 0, skipped: 0, failed: 0, failures: [] };
}

function batchSize(value: number | undefined) {
  const normalized = Math.trunc(value ?? 50);
  return Number.isFinite(normalized) ? Math.min(Math.max(normalized, 1), 100) : 50;
}

function failureCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return normalizeWorkerErrorCode(error.code);
  }
  return normalizeWorkerErrorCode(error instanceof Error ? error.name : error);
}

async function processCandidate(client: PoolClient, versionId: string) {
  const result = await client.query<{ activated: boolean }>(`
    SELECT configuration_activation_worker_activate($1) AS activated
  `, [versionId]);
  return result.rows[0]?.activated ? "activated" as const : "skipped" as const;
}

export async function runDueConfigurationActivations(pool: Pool, input: {
  now?: Date;
  batchSize?: number;
} = {}): Promise<ConfigurationActivationWorkerResult> {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  let leaseAcquired = false;
  let releaseError: Error | undefined;
  try {
    const lease = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
      [CONFIGURATION_ACTIVATION_WORKER_LEASE_KEY],
    );
    leaseAcquired = lease.rows[0]?.acquired === true;
    if (!leaseAcquired) return emptyResult(false);
    const candidates = await client.query<{ id: string }>(`
      SELECT version.id
        FROM configuration_versions AS version
        JOIN configuration_schedules AS schedule ON schedule.configuration_version_id=version.id
        JOIN configuration_approvals AS approval ON approval.configuration_version_id=version.id
       WHERE schedule.scheduled_for <= $1::timestamptz
         AND approval.decision='approve'
         AND (
           SELECT test.result
             FROM configuration_test_results AS test
            WHERE test.configuration_version_id=version.id
            ORDER BY test.sequence_no DESC
            LIMIT 1
         )='passed'
         AND NOT EXISTS (
           SELECT 1 FROM configuration_activations AS activation
            WHERE activation.configuration_version_id=version.id
         )
       ORDER BY schedule.scheduled_for,version.id
       LIMIT $2
    `, [now.toISOString(), batchSize(input.batchSize)]);
    const result = emptyResult(true);
    result.scanned = candidates.rows.length;
    for (const candidate of candidates.rows) {
      try {
        const outcome = await processCandidate(client, candidate.id);
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        result.failures.push({ versionId: candidate.id, code: failureCode(error) });
      }
    }
    return result;
  } finally {
    if (leaseAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [CONFIGURATION_ACTIVATION_WORKER_LEASE_KEY]);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error("Configuration activation lease release failed");
      }
    }
    client.release(releaseError);
  }
}
