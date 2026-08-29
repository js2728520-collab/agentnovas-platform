import { createHash, randomUUID, type KeyObject } from "node:crypto";

import {
  RestrictedCicdGithubError,
  buildRestrictedCicdProviderBindingMaterial,
  cancelRestrictedCicdWorkflowRun,
  dispatchPreparedRestrictedCicdWorkflow,
  prepareRestrictedCicdDispatch,
  verifyRestrictedCicdProviderBinding,
  verifyRestrictedCicdWorkflowRun,
  withRestrictedCicdInstallationToken,
  type PreparedRestrictedCicdDispatch,
  type RestrictedCicdGithubBinding,
} from "./restricted-cicd-github.ts";
import type { ReleaseWorkflowAction, ReleaseWorkflowEnvironment } from "./restricted-cicd-domain.ts";

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Queryable = { query: (text: string, values?: unknown[]) => Promise<QueryResult> };

export type RestrictedCicdClaim = {
  attemptKey: string;
  fencingToken: number;
  commandId: string;
  releaseVersionId: string;
  environment: ReleaseWorkflowEnvironment;
  action: ReleaseWorkflowAction;
  snapshotSha256: string;
  artifactManifestSha256: string;
  workflowSha256: string;
  environmentGeneration: number;
  expectedCurrentReleaseVersionId: string | null;
  leaseExpiresAt: Date;
  activationId: string;
  replayed: boolean;
};

export type RestrictedCicdReconciliationCandidate = {
  attemptKey: string;
  commandId: string;
  workerId: string;
  fencingToken: number;
  providerRunId: string;
};

export type RestrictedCicdWorkerDatabase = {
  recoverExpiredDispatch(environment: ReleaseWorkflowEnvironment): Promise<{ attemptKey: string; commandId: string } | null>;
  claimNextReconciliation(binding: RestrictedCicdGithubBinding): Promise<RestrictedCicdReconciliationCandidate | null>;
  claimNext(input: {
    attemptKey: string;
    workerId: string;
    leaseSeconds: number;
    binding: RestrictedCicdGithubBinding;
  }): Promise<RestrictedCicdClaim | null>;
  beginDispatch(input: {
    attemptKey: string;
    workerId: string;
    fencingToken: number;
    dispatchRequestSha256: string;
  }): Promise<{ replayed: boolean }>;
  bindProviderRun(input: {
    attemptKey: string;
    workerId: string;
    fencingToken: number;
    providerRunId: string;
    providerRunUrl: string;
    dispatchRequestSha256: string;
  }): Promise<{ providerRunId: string; replayed: boolean }>;
  recordDispatchUnknown(input: {
    attemptKey: string;
    workerId: string;
    fencingToken: number;
    dispatchRequestSha256: string;
    outcomeCode: "timeout" | "transport_failure" | "unexpected_status" | "malformed_response" | "bind_commit_failure" | "worker_recovery";
  }): Promise<{ recorded: boolean; providerRunId: string | null; replayed: boolean }>;
  rejectBoundRun(input: {
    eventId: string;
    attemptKey: string;
    workerId: string;
    fencingToken: number;
    providerRunId: string;
    evidenceSha256: string;
    reasonCode: "exact_run_mismatch" | "exact_run_verification_unavailable";
  }): Promise<{ eventId: string; replayed: boolean }>;
  appendProviderEvent(input: {
    eventId: string;
    attemptKey: string;
    workerId: string;
    fencingToken: number;
    providerRunId: string;
    kind: "provider_queued" | "provider_in_progress" | "completed_success" | "completed_failure" | "completed_cancelled";
    evidenceSha256: string;
    metadata: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<{ eventId: string; replayed: boolean }>;
};

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${name}`);
  return value;
}

function safePositiveInteger(value: unknown, name: string) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) throw new Error(`invalid ${name}`);
  return Number(parsed);
}

function booleanValue(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`invalid ${name}`);
  return value;
}

function claimFromRow(row: Record<string, unknown>): RestrictedCicdClaim {
  const environment = requiredString(row.environment, "environment");
  const action = requiredString(row.action, "action");
  if (environment !== "staging" && environment !== "production") throw new Error("invalid environment");
  if (action !== "deploy" && action !== "rollback") throw new Error("invalid action");
  const expires = row.lease_expires_at instanceof Date
    ? new Date(row.lease_expires_at.getTime())
    : new Date(requiredString(row.lease_expires_at, "lease expiry"));
  if (!Number.isFinite(expires.getTime())) throw new Error("invalid lease expiry");
  return {
    attemptKey: requiredString(row.attempt_key, "attempt key"),
    fencingToken: safePositiveInteger(row.fencing_token, "fencing token"),
    commandId: requiredString(row.command_id, "command id"),
    releaseVersionId: requiredString(row.release_version_id, "release version id"),
    environment,
    action,
    snapshotSha256: requiredString(row.snapshot_sha256, "snapshot digest"),
    artifactManifestSha256: requiredString(row.artifact_manifest_sha256, "artifact digest"),
    workflowSha256: requiredString(row.workflow_sha256, "workflow digest"),
    environmentGeneration: safePositiveInteger(row.environment_generation, "environment generation"),
    expectedCurrentReleaseVersionId: row.expected_current_release_version_id === null
      ? null
      : requiredString(row.expected_current_release_version_id, "expected current release"),
    leaseExpiresAt: expires,
    activationId: requiredString(row.activation_id, "activation id"),
    replayed: booleanValue(row.replayed, "claim replay flag"),
  };
}

export function createRestrictedCicdWorkerDatabase(queryable: Queryable): RestrictedCicdWorkerDatabase {
  return {
    async recoverExpiredDispatch(environment) {
      const result = await queryable.query(
        "SELECT * FROM release_workflow_recover_expired_dispatch_v2($1)",
        [environment],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error("dispatch recovery gateway returned multiple rows");
      return {
        attemptKey: requiredString(result.rows[0].attempt_key, "recovered attempt key"),
        commandId: requiredString(result.rows[0].command_id, "recovered command id"),
      };
    },
    async claimNextReconciliation(binding) {
      const result = await queryable.query(
        "SELECT * FROM release_workflow_claim_next_reconciliation_v2($1,$2,$3::jsonb)",
        [binding.environment, binding.providerBindingSha256, buildRestrictedCicdProviderBindingMaterial(binding)],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error("reconciliation gateway returned multiple rows");
      return {
        attemptKey: requiredString(result.rows[0].attempt_key, "reconciliation attempt key"),
        commandId: requiredString(result.rows[0].command_id, "reconciliation command id"),
        workerId: requiredString(result.rows[0].lease_owner, "reconciliation worker id"),
        fencingToken: safePositiveInteger(result.rows[0].fencing_token, "reconciliation fencing token"),
        providerRunId: requiredString(result.rows[0].provider_run_id, "reconciliation run id"),
      };
    },
    async claimNext(input) {
      const result = await queryable.query(`
        SELECT * FROM release_workflow_claim_next_command_v2(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
        )
      `, [
        input.attemptKey,
        input.workerId,
        input.leaseSeconds,
        input.binding.environment,
        input.binding.g7ManifestSha256,
        input.binding.providerBindingSha256,
        input.binding.environmentPolicySha256,
        input.binding.runnerPolicySha256,
        input.binding.targetBindingSha256,
        input.binding.receiptTrustSha256,
        input.binding.auditorTrustSha256,
        input.binding.productionReviewerAllowlistSha256,
        buildRestrictedCicdProviderBindingMaterial(input.binding),
      ]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error("claim gateway returned multiple rows");
      return claimFromRow(result.rows[0]);
    },
    async beginDispatch(input) {
      const result = await queryable.query(`
        SELECT * FROM release_workflow_begin_dispatch($1,$2,$3,$4)
      `, [input.attemptKey, input.workerId, input.fencingToken, input.dispatchRequestSha256]);
      if (result.rows.length !== 1) throw new Error("begin dispatch gateway response invalid");
      return { replayed: booleanValue(result.rows[0].replayed, "begin replay flag") };
    },
    async bindProviderRun(input) {
      const result = await queryable.query(`
        SELECT * FROM release_workflow_bind_provider_run($1,$2,$3,$4,$5,$6)
      `, [
        input.attemptKey, input.workerId, input.fencingToken, input.providerRunId,
        input.providerRunUrl, input.dispatchRequestSha256,
      ]);
      if (result.rows.length !== 1) throw new Error("bind gateway response invalid");
      return {
        providerRunId: requiredString(result.rows[0].provider_run_id, "provider run id"),
        replayed: booleanValue(result.rows[0].replayed, "bind replay flag"),
      };
    },
    async recordDispatchUnknown(input) {
      const result = await queryable.query(`
        SELECT * FROM release_workflow_record_dispatch_unknown($1,$2,$3,$4,$5)
      `, [
        input.attemptKey, input.workerId, input.fencingToken,
        input.dispatchRequestSha256, input.outcomeCode,
      ]);
      if (result.rows.length !== 1) throw new Error("dispatch uncertainty gateway response invalid");
      return {
        recorded: booleanValue(result.rows[0].recorded, "uncertainty recorded flag"),
        providerRunId: result.rows[0].provider_run_id === null
          ? null
          : requiredString(result.rows[0].provider_run_id, "provider run id"),
        replayed: booleanValue(result.rows[0].replayed, "uncertainty replay flag"),
      };
    },
    async rejectBoundRun(input) {
      const result = await queryable.query(`
        SELECT * FROM release_workflow_reject_bound_run($1,$2,$3,$4,$5,$6,$7)
      `, [
        input.eventId, input.attemptKey, input.workerId, input.fencingToken,
        input.providerRunId, input.evidenceSha256, input.reasonCode,
      ]);
      if (result.rows.length !== 1) throw new Error("bound run rejection gateway response invalid");
      return {
        eventId: requiredString(result.rows[0].event_id, "event id"),
        replayed: booleanValue(result.rows[0].replayed, "rejection replay flag"),
      };
    },
    async appendProviderEvent(input) {
      const result = await queryable.query(`
        SELECT * FROM release_workflow_append_provider_event(
          $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9
        )
      `, [
        input.eventId, input.attemptKey, input.workerId, input.fencingToken,
        input.providerRunId, input.kind, input.evidenceSha256,
        JSON.stringify(input.metadata), input.occurredAt,
      ]);
      if (result.rows.length !== 1) throw new Error("provider event gateway response invalid");
      return {
        eventId: requiredString(result.rows[0].event_id, "provider event id"),
        replayed: booleanValue(result.rows[0].replayed, "provider event replay flag"),
      };
    },
  };
}

type RestrictedCicdWorkerProvider = {
  withInstallationToken<T>(callback: (token: string) => Promise<T>): Promise<T>;
  verifyBinding(token: string): Promise<{ controlCommitSha: string; workflowSha256: string }>;
  dispatchPrepared(token: string, prepared: PreparedRestrictedCicdDispatch): Promise<{
    providerRunId: string;
    providerRunUrl: string;
    dispatchRequestSha256: string;
  }>;
  verifyRun(token: string, providerRunId: string): Promise<unknown>;
  cancelRun(token: string, providerRunId: string): Promise<unknown>;
};

function defaultProvider(binding: RestrictedCicdGithubBinding, privateKey: KeyObject): RestrictedCicdWorkerProvider {
  return {
    withInstallationToken: (callback) => withRestrictedCicdInstallationToken(binding, privateKey, {}, callback),
    verifyBinding: (token) => verifyRestrictedCicdProviderBinding(binding, token),
    dispatchPrepared: (token, prepared) => dispatchPreparedRestrictedCicdWorkflow(binding, token, prepared),
    verifyRun: (token, providerRunId) => verifyRestrictedCicdWorkflowRun(binding, token, providerRunId),
    cancelRun: (token, providerRunId) => cancelRestrictedCicdWorkflowRun(binding, token, providerRunId),
  };
}

function validRuntimeId(value: string) {
  return value.length >= 3 && value.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9_-]+$/.test(value);
}

function evidenceDigest(providerRunId: string, reasonCode: string) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: "1",
    providerRunId,
    runAttempt: 1,
    reasonCode,
  })).digest("hex");
}

async function quarantineBoundRun(
  database: RestrictedCicdWorkerDatabase,
  provider: RestrictedCicdWorkerProvider,
  token: string,
  claim: Pick<RestrictedCicdClaim, "attemptKey" | "commandId" | "fencingToken">,
  workerId: string,
  providerRunId: string,
  reasonCode: "exact_run_mismatch" | "exact_run_verification_unavailable",
  eventIdFactory: () => string,
) {
  const eventId = eventIdFactory();
  if (!validRuntimeId(eventId)) throw new Error("restricted CI/CD event id invalid");
  await database.rejectBoundRun({
    eventId,
    attemptKey: claim.attemptKey,
    workerId,
    fencingToken: claim.fencingToken,
    providerRunId,
    evidenceSha256: evidenceDigest(providerRunId, reasonCode),
    reasonCode,
  });
  let cancellationRequested = false;
  try {
    await provider.cancelRun(token, providerRunId);
    cancellationRequested = true;
  } catch {
    // The database quarantine is authoritative. Cancellation is best-effort and
    // its uncertainty must never reopen target authorization.
  }
  return cancellationRequested;
}

function providerEventFromVerifiedRun(value: unknown, providerRunId: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("provider run state invalid");
  }
  const run = value as Record<string, unknown>;
  if (run.providerRunId !== providerRunId || run.runAttempt !== 1
    || typeof run.status !== "string"
    || (run.conclusion !== null && typeof run.conclusion !== "string")
    || typeof run.updatedAt !== "string") {
    throw new Error("provider run state invalid");
  }
  const occurredAt = new Date(run.updatedAt);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("provider run state invalid");
  let kind: "provider_queued" | "provider_in_progress" | "completed_success" | "completed_failure" | "completed_cancelled";
  let conclusion: "success" | "failure" | "cancelled" | null = null;
  if (run.status === "completed") {
    if (run.conclusion === "success") {
      kind = "completed_success";
      conclusion = "success";
    } else if (run.conclusion === "cancelled") {
      kind = "completed_cancelled";
      conclusion = "cancelled";
    } else {
      kind = "completed_failure";
      conclusion = "failure";
    }
  } else if (run.status === "in_progress") {
    kind = "provider_in_progress";
  } else if (["queued", "requested", "waiting", "pending"].includes(run.status)) {
    kind = "provider_queued";
  } else {
    throw new Error("provider run state invalid");
  }
  const metadata = {
    runId: providerRunId,
    runAttempt: 1,
    status: run.status,
    conclusion,
    providerUpdatedAt: occurredAt.toISOString(),
  };
  const evidenceSha256 = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
  return {
    eventId: `provider-${evidenceSha256.slice(0, 48)}`,
    kind,
    evidenceSha256,
    metadata,
    occurredAt,
  };
}

export async function runRestrictedCicdReconciliationIteration(
  database: RestrictedCicdWorkerDatabase,
  binding: RestrictedCicdGithubBinding,
  privateKey: KeyObject,
  options: {
    provider?: RestrictedCicdWorkerProvider;
    eventIdFactory?: () => string;
  } = {},
) {
  const provider = options.provider ?? defaultProvider(binding, privateKey);
  const eventIdFactory = options.eventIdFactory ?? (() => `event-${randomUUID()}`);
  return provider.withInstallationToken(async (token) => {
    const verifiedBinding = await provider.verifyBinding(token);
    if (verifiedBinding.controlCommitSha !== binding.controlCommitSha
      || verifiedBinding.workflowSha256 !== binding.workflowSha256) {
      throw new RestrictedCicdGithubError("PROVIDER_BINDING_DRIFT", "GitHub provider binding drift detected");
    }
    const candidate = await database.claimNextReconciliation(binding);
    if (!candidate) return { outcome: "idle" as const };
    let verifiedRun: unknown;
    try {
      verifiedRun = await provider.verifyRun(token, candidate.providerRunId);
    } catch (error) {
      const reasonCode = error instanceof RestrictedCicdGithubError && error.code === "EXACT_RUN_MISMATCH"
        ? "exact_run_mismatch" as const
        : "exact_run_verification_unavailable" as const;
      const cancellationRequested = await quarantineBoundRun(
        database, provider, token, candidate, candidate.workerId, candidate.providerRunId,
        reasonCode, eventIdFactory,
      );
      return {
        outcome: "manual_intervention" as const,
        commandId: candidate.commandId,
        providerRunId: candidate.providerRunId,
        reasonCode,
        cancellationRequested,
      };
    }
    const event = providerEventFromVerifiedRun(verifiedRun, candidate.providerRunId);
    await database.appendProviderEvent({
      ...event,
      attemptKey: candidate.attemptKey,
      workerId: candidate.workerId,
      fencingToken: candidate.fencingToken,
      providerRunId: candidate.providerRunId,
    });
    return {
      outcome: "provider_reconciled" as const,
      commandId: candidate.commandId,
      providerRunId: candidate.providerRunId,
      providerEventKind: event.kind,
    };
  });
}

export async function runRestrictedCicdWorkerIteration(
  database: RestrictedCicdWorkerDatabase,
  binding: RestrictedCicdGithubBinding,
  privateKey: KeyObject,
  options: {
    workerId: string;
    leaseSeconds?: number;
    attemptKeyFactory?: () => string;
    eventIdFactory?: () => string;
    provider?: RestrictedCicdWorkerProvider;
  },
) {
  if (!validRuntimeId(options.workerId)) throw new Error("restricted CI/CD worker id invalid");
  const leaseSeconds = options.leaseSeconds ?? 300;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
    throw new Error("restricted CI/CD lease duration invalid");
  }
  const attemptKeyFactory = options.attemptKeyFactory ?? (() => `attempt-${randomUUID()}`);
  const eventIdFactory = options.eventIdFactory ?? (() => `event-${randomUUID()}`);
  const provider = options.provider ?? defaultProvider(binding, privateKey);

  const recovered = await database.recoverExpiredDispatch(binding.environment);
  if (recovered) {
    return {
      outcome: "manual_intervention" as const,
      commandId: recovered.commandId,
      reasonCode: "worker_recovery" as const,
    };
  }

  return provider.withInstallationToken(async (token) => {
    const verifiedBinding = await provider.verifyBinding(token);
    if (verifiedBinding.controlCommitSha !== binding.controlCommitSha
      || verifiedBinding.workflowSha256 !== binding.workflowSha256) {
      throw new RestrictedCicdGithubError(
        "PROVIDER_BINDING_DRIFT",
        "GitHub provider binding drift detected",
      );
    }
    const attemptKey = attemptKeyFactory();
    if (!validRuntimeId(attemptKey)) throw new Error("restricted CI/CD attempt key invalid");
    const claim = await database.claimNext({
      attemptKey,
      workerId: options.workerId,
      leaseSeconds,
      binding,
    });
    if (!claim) return { outcome: "idle" as const };
    if (claim.environment !== binding.environment) {
      throw new Error("restricted CI/CD claim environment mismatch");
    }
    if (claim.workflowSha256 !== verifiedBinding.workflowSha256) {
      throw new RestrictedCicdGithubError(
        "PROVIDER_BINDING_DRIFT",
        "GitHub provider binding drift detected",
      );
    }

    const prepared = prepareRestrictedCicdDispatch(binding, {
      commandId: claim.commandId,
      releaseVersionId: claim.releaseVersionId,
      environment: claim.environment,
      action: claim.action,
      artifactManifestSha256: claim.artifactManifestSha256,
      environmentGeneration: claim.environmentGeneration,
    });
    const begun = await database.beginDispatch({
      attemptKey: claim.attemptKey,
      workerId: options.workerId,
      fencingToken: claim.fencingToken,
      dispatchRequestSha256: prepared.dispatchRequestSha256,
    });
    if (begun.replayed) {
      await database.recordDispatchUnknown({
        attemptKey: claim.attemptKey,
        workerId: options.workerId,
        fencingToken: claim.fencingToken,
        dispatchRequestSha256: prepared.dispatchRequestSha256,
        outcomeCode: "worker_recovery",
      });
      return { outcome: "manual_intervention" as const, commandId: claim.commandId, reasonCode: "worker_recovery" as const };
    }

    let dispatched: Awaited<ReturnType<RestrictedCicdWorkerProvider["dispatchPrepared"]>>;
    try {
      dispatched = await provider.dispatchPrepared(token, prepared);
    } catch {
      await database.recordDispatchUnknown({
        attemptKey: claim.attemptKey,
        workerId: options.workerId,
        fencingToken: claim.fencingToken,
        dispatchRequestSha256: prepared.dispatchRequestSha256,
        outcomeCode: "transport_failure",
      });
      return { outcome: "manual_intervention" as const, commandId: claim.commandId, reasonCode: "transport_failure" as const };
    }
    if (dispatched.dispatchRequestSha256 !== prepared.dispatchRequestSha256) {
      throw new Error("dispatch response digest mismatch");
    }

    let bound = false;
    for (let attempt = 0; attempt < 2 && !bound; attempt += 1) {
      try {
        await database.bindProviderRun({
          attemptKey: claim.attemptKey,
          workerId: options.workerId,
          fencingToken: claim.fencingToken,
          providerRunId: dispatched.providerRunId,
          providerRunUrl: dispatched.providerRunUrl,
          dispatchRequestSha256: prepared.dispatchRequestSha256,
        });
        bound = true;
      } catch {
        // The gateway is idempotent. One immediate exact replay distinguishes a
        // lost commit response from a durable failure without another POST.
      }
    }
    if (!bound) {
      const uncertainty = await database.recordDispatchUnknown({
        attemptKey: claim.attemptKey,
        workerId: options.workerId,
        fencingToken: claim.fencingToken,
        dispatchRequestSha256: prepared.dispatchRequestSha256,
        outcomeCode: "bind_commit_failure",
      });
      if (uncertainty.providerRunId !== dispatched.providerRunId) {
        return { outcome: "manual_intervention" as const, commandId: claim.commandId, reasonCode: "bind_commit_failure" as const };
      }
    }

    try {
      await provider.verifyRun(token, dispatched.providerRunId);
    } catch (error) {
      const reasonCode = error instanceof RestrictedCicdGithubError && error.code === "EXACT_RUN_MISMATCH"
        ? "exact_run_mismatch" as const
        : "exact_run_verification_unavailable" as const;
      const cancellationRequested = await quarantineBoundRun(
        database,
        provider,
        token,
        claim,
        options.workerId,
        dispatched.providerRunId,
        reasonCode,
        eventIdFactory,
      );
      return {
        outcome: "manual_intervention" as const,
        commandId: claim.commandId,
        providerRunId: dispatched.providerRunId,
        reasonCode,
        cancellationRequested,
      };
    }
    return {
      outcome: "dispatch_accepted" as const,
      commandId: claim.commandId,
      providerRunId: dispatched.providerRunId,
    };
  });
}
