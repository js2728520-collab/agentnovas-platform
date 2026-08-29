import { createHash, type KeyObject } from "node:crypto";

import type { TargetOperationIdentity } from "./restricted-cicd-domain.ts";
import type {
  RestrictedCicdDeploymentMaterial,
  createRestrictedCicdTargetAdapter,
} from "./restricted-cicd-target-adapter.ts";
import {
  signRestrictedCicdLocalStopReceipt,
  signRestrictedCicdTargetReceipt,
  signRestrictedCicdStopReceipt,
  type TargetJournalPhase,
  type createRestrictedCicdTargetJournal,
} from "./restricted-cicd-target-journal.ts";
import type {
  RestrictedCicdTargetClearRequest,
  RestrictedCicdTargetStopRequest,
  createRestrictedCicdTargetDatabase,
} from "./restricted-cicd-target.ts";

type TargetDatabase = ReturnType<typeof createRestrictedCicdTargetDatabase>;
type TargetAdapter = ReturnType<typeof createRestrictedCicdTargetAdapter>;
type TargetJournal = Awaited<ReturnType<typeof createRestrictedCicdTargetJournal>>;
type JournalDocument = NonNullable<Awaited<ReturnType<TargetJournal["load"]>>>;
type JournalCheckpoint = JournalDocument["checkpoints"][number];

function evidence(identity: TargetOperationIdentity, phase: TargetJournalPhase, extra: unknown = null) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: "1",
    operationId: identity.operationId,
    commandId: identity.commandId,
    snapshotSha256: identity.snapshotSha256,
    phase,
    extra,
  })).digest("hex");
}

export async function executeRestrictedCicdTargetClearAcknowledgement(input: {
  request: RestrictedCicdTargetClearRequest;
  actorFingerprintSha256: string;
  ownerIdentitySha256: string;
  database: TargetDatabase;
  journal: TargetJournal;
  receiptPrivateKey: KeyObject;
  receiptPublicKeyFor: (keyId: string, signedAt: Date) => KeyObject;
  receiptKeyId: string;
  receiptTrustSha256: string;
}) {
  return input.journal.withEnvironmentMutex({
    environment: input.request.environment,
    operationId: input.request.stopId,
    ownerEpoch: 1,
    ownerIdentitySha256: input.ownerIdentitySha256,
  }, async () => {
    const local = await input.journal.loadLocalStop(input.request.environment);
    const active = [...(local?.events ?? [])].reverse()
      .find((event) => event.phase === "stop_committed" || event.phase === "clear_acknowledged");
    if (!local || active?.phase !== "stop_committed" || active.stopId !== input.request.stopId) {
      throw new Error("target-local stop is not active");
    }
    const prepared = await input.database.prepareClearAcknowledgement(
      input.request, input.receiptTrustSha256,
    );
    const generated = signRestrictedCicdStopReceipt({
      stopId: input.request.stopId,
      environment: input.request.environment,
      generation: input.request.generation,
      phase: "clear_acknowledged",
      activationId: input.request.activationId,
      expectedCurrentReleaseVersionId: input.request.expectedCurrentReleaseVersionId,
      requestedAt: prepared.stopRequestedAt,
      receiptNonce: `${input.request.stopId}-clear-acknowledged`,
      keyId: input.receiptKeyId,
      actorKind: "target",
      actorFingerprintSha256: input.actorFingerprintSha256,
      privateKey: input.receiptPrivateKey,
    });
    const receiptId = `${input.request.stopId}-receipt-clear-acknowledged`;
    const persisted = await input.journal.saveLocalStopPlatformReceipt({
      environment: input.request.environment,
      stopId: input.request.stopId,
      authorizationEpoch: active.authorizationEpoch,
      receiptId,
      receiptPhase: "clear_acknowledged",
      recordedAt: new Date(),
      signed: generated,
    });
    const persistedKeyId = persisted.signed.payload.keyId;
    if (typeof persistedKeyId !== "string") throw new Error("persisted stop receipt key invalid");
    const receipt = await input.database.appendStopReceipt({
      receiptId,
      signed: persisted.signed,
      publicKey: input.receiptPublicKeyFor(persistedKeyId, persisted.recordedAt),
      receiptTrustSha256: input.receiptTrustSha256,
    });
    return { phase: "clear_acknowledged" as const, replayed: receipt.replayed };
  });
}

export async function executeRestrictedCicdTargetClearCommit(input: {
  request: RestrictedCicdTargetClearRequest;
  actorFingerprintSha256: string;
  ownerIdentitySha256: string;
  database: TargetDatabase;
  journal: TargetJournal;
  receiptPrivateKey: KeyObject;
  receiptKeyId: string;
  receiptTrustSha256: string;
}) {
  return input.journal.withEnvironmentMutex({
    environment: input.request.environment,
    operationId: input.request.stopId,
    ownerEpoch: 1,
    ownerIdentitySha256: input.ownerIdentitySha256,
  }, async () => {
    const local = await input.journal.loadLocalStop(input.request.environment);
    const active = [...(local?.events ?? [])].reverse()
      .find((event) => event.phase === "stop_committed" || event.phase === "clear_acknowledged");
    if (!local || active?.phase !== "stop_committed" || active.stopId !== input.request.stopId) {
      throw new Error("target-local stop is not active");
    }
    const cleared = await input.database.validateStopCleared(input.request, input.receiptTrustSha256);
    const signed = signRestrictedCicdStopReceipt({
      stopId: input.request.stopId,
      environment: input.request.environment,
      generation: input.request.generation,
      phase: "clear_acknowledged",
      activationId: input.request.activationId,
      expectedCurrentReleaseVersionId: input.request.expectedCurrentReleaseVersionId,
      requestedAt: cleared.clearedAt,
      receiptNonce: `${input.request.stopId}-local-clear-committed`,
      keyId: input.receiptKeyId,
      actorKind: "target",
      actorFingerprintSha256: input.actorFingerprintSha256,
      privateKey: input.receiptPrivateKey,
    });
    const committed = await input.journal.appendLocalStopClear({
      environment: input.request.environment,
      stopId: input.request.stopId,
      authorizationEpoch: active.authorizationEpoch,
      activationId: input.request.activationId,
      recordedAt: cleared.clearedAt,
      signed,
    });
    return {
      phase: "clear_committed" as const,
      generation: cleared.clearedGeneration,
      replayed: committed.replayed,
    };
  });
}

function checkpointFor(journal: JournalDocument | null, phase: TargetJournalPhase) {
  return journal?.checkpoints.find((checkpoint) => checkpoint.phase === phase) ?? null;
}

export async function executeRestrictedCicdTargetOperation(input: {
  identity: TargetOperationIdentity;
  material: RestrictedCicdDeploymentMaterial;
  ownerEpoch: number;
  ownerIdentitySha256: string;
  database: TargetDatabase;
  journal: TargetJournal;
  adapter: TargetAdapter;
  receiptPrivateKey: KeyObject;
  receiptPublicKeyFor: (keyId: string, signedAt: Date) => KeyObject;
  receiptKeyId: string;
  targetBindingSha256: string;
  receiptTrustSha256: string;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return input.journal.withOperationLock({
    environment: input.identity.environment,
    operationId: input.identity.operationId,
    commandId: input.identity.commandId,
    ownerEpoch: input.ownerEpoch,
    ownerIdentitySha256: input.ownerIdentitySha256,
  }, async (session) => {
    let journal = await session.load();
    let backup: {
      backupId: string;
      backupSha256: string;
      restoreTocSha256: string;
      restorePlanSha256: string;
      createdAt: Date;
    } | null = null;

    async function append(
      phase: TargetJournalPhase,
      actualPreviousReleaseVersionId: string | null,
      actualCurrentReleaseVersionId: string | null,
      extra: unknown = null,
    ): Promise<JournalCheckpoint> {
      const existing = checkpointFor(journal, phase);
      if (existing) return existing;
      const appended = await session.append({
        phase,
        evidenceSha256: evidence(input.identity, phase, extra),
        recordedAt: now(),
        actualPreviousReleaseVersionId,
        actualCurrentReleaseVersionId,
      });
      journal = appended.journal;
      return appended.journal.checkpoints.at(-1) as JournalCheckpoint;
    }

    async function publish(checkpoint: JournalCheckpoint) {
      const startedAt = new Date((journal as JournalDocument).checkpoints[0].recordedAt);
      const receiptId = `${input.identity.operationId}-receipt-${checkpoint.phase}`;
      const generated = signRestrictedCicdTargetReceipt({
        identity: input.identity,
        imageDigests: input.material.imageDigests,
        migrationRegistrySha256: input.material.migrationSetSha256,
        backupId: backup?.backupId ?? (checkpointFor(journal, "applying")
          ? `backup-${input.identity.operationId}` : null),
        journalPhase: checkpoint.phase,
        journalSequence: checkpoint.sequence,
        ownerEpoch: checkpoint.ownerEpoch,
        startedAt,
        completedAt: new Date(checkpoint.recordedAt),
        actualPreviousReleaseVersionId: checkpoint.actualPreviousReleaseVersionId,
        actualCurrentReleaseVersionId: checkpoint.actualCurrentReleaseVersionId,
        receiptNonce: `${input.identity.operationId}-${checkpoint.phase}`,
        keyId: input.receiptKeyId,
        privateKey: input.receiptPrivateKey,
      });
      const prior = (journal as JournalDocument).receipts[receiptId];
      const persisted = await session.saveReceipt(receiptId,
        (prior ?? generated) as typeof generated);
      journal = persisted.journal;
      const persistedKeyId = persisted.signed.payload.keyId;
      const persistedCompletedAt = persisted.signed.payload.completedAt;
      if (typeof persistedKeyId !== "string" || typeof persistedCompletedAt !== "string") {
        throw new Error("persisted target receipt trust metadata invalid");
      }
      await input.database.appendReceipt({
        receiptId,
        signed: persisted.signed,
        publicKey: input.receiptPublicKeyFor(persistedKeyId, new Date(persistedCompletedAt)),
      });
    }

    const terminal = journal?.checkpoints.at(-1);
    if (terminal && [
      "failed_before_cutover", "uncertain_before_cutover", "health_verified",
      "health_failed_after_cutover", "uncertain_after_cutover", "stop_committed",
    ].includes(terminal.phase)) {
      const cutover = checkpointFor(journal, "cutover_committed");
      if (cutover) await publish(cutover);
      await publish(terminal);
      return { phase: terminal.phase, replayed: true } as const;
    }

    if (input.journal.isLocalStopActive(await input.journal.loadLocalStop(input.identity.environment))) {
      const stopped = await append("stop_committed", input.identity.expectedCurrentReleaseVersionId,
        input.identity.expectedCurrentReleaseVersionId, "target_local_stop_active");
      await publish(stopped);
      return { phase: stopped.phase, replayed: false } as const;
    }

    await append("prepared", input.identity.expectedCurrentReleaseVersionId,
      input.identity.expectedCurrentReleaseVersionId);
    const cutoverIntentAlreadyDurable = checkpointFor(journal, "cutover_intent_durable") !== null;
    if (!cutoverIntentAlreadyDurable) {
      try {
        await input.database.validateAuthority({
          operationId: input.identity.operationId,
          ownerEpoch: input.ownerEpoch,
          snapshotSha256: input.identity.snapshotSha256,
          environmentGeneration: input.identity.environmentGeneration,
          expectedCurrentReleaseVersionId: input.identity.expectedCurrentReleaseVersionId,
          releaseVersionId: input.identity.releaseVersionId,
          targetBindingSha256: input.targetBindingSha256,
          receiptTrustSha256: input.receiptTrustSha256,
        });
      } catch {
        const phase = checkpointFor(journal, "applying")
          ? "uncertain_before_cutover" as const : "failed_before_cutover" as const;
        const rejected = await append(phase, input.identity.expectedCurrentReleaseVersionId,
          input.identity.expectedCurrentReleaseVersionId, "recovery_authority_validation_failed");
        await publish(rejected);
        return { phase: rejected.phase, replayed: false } as const;
      }
      try {
        await input.adapter.prepare(input.identity, input.material);
        backup = await input.adapter.createBackup(input.identity, input.material);
      } catch {
        const failed = await append("failed_before_cutover", input.identity.expectedCurrentReleaseVersionId,
          input.identity.expectedCurrentReleaseVersionId, "prepare_failed");
        await publish(failed);
        return { phase: failed.phase, replayed: false } as const;
      }

      const applyingAlreadyDurable = checkpointFor(journal, "applying") !== null;
      await append("applying", input.identity.expectedCurrentReleaseVersionId,
        input.identity.expectedCurrentReleaseVersionId, backup?.backupId);
      try {
        let registryAlreadyApplied = false;
        if (applyingAlreadyDurable) {
          try {
            await input.database.assertMigrationRegistry(input.material.migrationSetSha256);
            registryAlreadyApplied = true;
          } catch {
            registryAlreadyApplied = false;
          }
        }
        if (!registryAlreadyApplied) {
          await input.database.validateAuthority({
            operationId: input.identity.operationId,
            ownerEpoch: input.ownerEpoch,
            snapshotSha256: input.identity.snapshotSha256,
            environmentGeneration: input.identity.environmentGeneration,
            expectedCurrentReleaseVersionId: input.identity.expectedCurrentReleaseVersionId,
            releaseVersionId: input.identity.releaseVersionId,
            targetBindingSha256: input.targetBindingSha256,
            receiptTrustSha256: input.receiptTrustSha256,
          });
          await input.adapter.applyMigrations(input.identity, input.material);
          await input.database.assertMigrationRegistry(input.material.migrationSetSha256);
        }
      } catch {
        const uncertain = await append("uncertain_before_cutover", input.identity.expectedCurrentReleaseVersionId,
          input.identity.expectedCurrentReleaseVersionId, "migration_outcome_uncertain");
        await publish(uncertain);
        return { phase: uncertain.phase, replayed: false } as const;
      }
    }

    let cutover = checkpointFor(journal, "cutover_committed");
    if (cutover) await publish(cutover);
    if (!cutover) {
      const cutoverResult = await input.journal.withEnvironmentMutex({
        environment: input.identity.environment,
        operationId: input.identity.operationId,
        ownerEpoch: input.ownerEpoch,
        ownerIdentitySha256: input.ownerIdentitySha256,
      }, async () => {
        if (input.journal.isLocalStopActive(await input.journal.loadLocalStop(input.identity.environment))) {
          const stopped = await append("stop_committed", input.identity.expectedCurrentReleaseVersionId,
            input.identity.expectedCurrentReleaseVersionId, "target_local_stop_won_cutover_mutex");
          await publish(stopped);
          return { terminal: stopped };
        }
        await append("cutover_intent_durable", input.identity.expectedCurrentReleaseVersionId,
          input.identity.expectedCurrentReleaseVersionId);
        const assertOwned = () => input.journal.assertEnvironmentOwnership({
          environment: input.identity.environment,
          operationId: input.identity.operationId,
          ownerEpoch: input.ownerEpoch,
          ownerIdentitySha256: input.ownerIdentitySha256,
        });
        const fence = {
          ownerEpoch: input.ownerEpoch,
          ownerIdentitySha256: input.ownerIdentitySha256,
          assertOwned,
        };
        let committed = checkpointFor(journal, "cutover_committed");
        if (!committed) {
          await assertOwned();
          const alreadyConfirmed = await input.adapter.probeDesired(
            input.identity, input.material, input.ownerIdentitySha256,
          );
          if (alreadyConfirmed.matched) {
            await assertOwned();
            committed = await append("cutover_committed", input.identity.expectedCurrentReleaseVersionId,
              input.identity.releaseVersionId, "recovered_from_target_marker");
          } else {
            const physicallyApplied = await input.adapter.probePhysicalDesired(input.identity, input.material);
            if (physicallyApplied.matched) {
              await input.adapter.commitMarker(input.identity, input.material, fence);
              await assertOwned();
              committed = await append("cutover_committed", input.identity.expectedCurrentReleaseVersionId,
                input.identity.releaseVersionId, "recovered_from_physical_state");
            }
          }
        }
        if (!committed) {
          if (!backup) {
            try {
              await input.database.validateAuthority({
                operationId: input.identity.operationId,
                ownerEpoch: input.ownerEpoch,
                snapshotSha256: input.identity.snapshotSha256,
                environmentGeneration: input.identity.environmentGeneration,
                expectedCurrentReleaseVersionId: input.identity.expectedCurrentReleaseVersionId,
                releaseVersionId: input.identity.releaseVersionId,
                targetBindingSha256: input.targetBindingSha256,
                receiptTrustSha256: input.receiptTrustSha256,
              });
              backup = await input.adapter.createBackup(input.identity, input.material);
            } catch {
              const uncertain = await append("uncertain_before_cutover",
                input.identity.expectedCurrentReleaseVersionId,
                input.identity.expectedCurrentReleaseVersionId,
                "cutover_recovery_authority_validation_failed");
              await publish(uncertain);
              return { terminal: uncertain };
            }
          }
          try {
            await input.database.validateCutover({
              operationId: input.identity.operationId,
              ownerEpoch: input.ownerEpoch,
              snapshotSha256: input.identity.snapshotSha256,
              environmentGeneration: input.identity.environmentGeneration,
              expectedCurrentReleaseVersionId: input.identity.expectedCurrentReleaseVersionId,
              releaseVersionId: input.identity.releaseVersionId,
              targetBindingSha256: input.targetBindingSha256,
              receiptTrustSha256: input.receiptTrustSha256,
              backupId: backup.backupId,
              backupSha256: backup.backupSha256,
              restoreTocSha256: backup.restoreTocSha256,
              restorePlanSha256: backup.restorePlanSha256,
              backupCreatedAt: backup.createdAt,
            });
          } catch {
            const uncertain = await append("uncertain_before_cutover", input.identity.expectedCurrentReleaseVersionId,
              input.identity.expectedCurrentReleaseVersionId, "final_authority_validation_failed");
            await publish(uncertain);
            return { terminal: uncertain };
          }
          try {
            await input.adapter.cutover(input.identity, input.material, fence);
            await assertOwned();
            const confirmed = await input.adapter.probeDesired(
              input.identity, input.material, input.ownerIdentitySha256,
            );
            if (!confirmed.matched) throw new Error("cutover not confirmed");
            await assertOwned();
            committed = await append("cutover_committed", input.identity.expectedCurrentReleaseVersionId,
              input.identity.releaseVersionId);
          } catch {
            try {
              const physical = await input.adapter.probePhysicalDesired(input.identity, input.material);
              if (physical.matched) {
                await input.adapter.commitMarker(input.identity, input.material, fence);
                await assertOwned();
                committed = await append("cutover_committed", input.identity.expectedCurrentReleaseVersionId,
                  input.identity.releaseVersionId, "recovered_after_cutover_error");
              }
            } catch {
              // The signed uncertain outcome below is authoritative when recovery cannot prove a full cutover.
            }
            if (!committed) {
              const uncertain = await append("uncertain_after_cutover", input.identity.expectedCurrentReleaseVersionId,
                null, "physical_cutover_state_not_uniquely_confirmed");
              await publish(uncertain);
              return { terminal: uncertain };
            }
          }
        }
        await publish(committed);
        return { cutover: committed };
      });
      if (cutoverResult.terminal) {
        return { phase: cutoverResult.terminal.phase, replayed: false } as const;
      }
      cutover = cutoverResult.cutover ?? null;
    }
    if (!cutover) throw new Error("cutover outcome missing");

    let healthy = false;
    try {
      healthy = await input.adapter.healthCheck();
    } catch {
      healthy = false;
    }
    const health = await append(healthy ? "health_verified" : "health_failed_after_cutover",
      input.identity.expectedCurrentReleaseVersionId, input.identity.releaseVersionId);
    await publish(health);
    return { phase: health.phase, replayed: false } as const;
  });
}

export async function executeRestrictedCicdTargetStop(input: {
  request: RestrictedCicdTargetStopRequest;
  actorFingerprintSha256: string;
  ownerIdentitySha256: string;
  database: TargetDatabase;
  journal: TargetJournal;
  receiptPrivateKey: KeyObject;
  receiptPublicKeyFor: (keyId: string, signedAt: Date) => KeyObject;
  receiptKeyId: string;
  receiptTrustSha256: string;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const queued = await input.journal.enqueueLocalStopRequest({
    request: input.request,
    actorFingerprintSha256: input.actorFingerprintSha256,
    requestedAt: now(),
  });
  return input.journal.withEnvironmentMutex({
    environment: input.request.environment,
    operationId: input.request.stopId,
    ownerEpoch: 1,
    ownerIdentitySha256: input.ownerIdentitySha256,
  }, async () => {
    const actorKind = input.request.actorKind === "break_glass" ? "break_glass" : "target";
    const existing = await input.journal.loadLocalStop(input.request.environment);
    const prior = existing?.events.find((event) => event.phase === "stop_committed"
      && event.stopId === input.request.stopId) as undefined | {
        phase: "stop_committed";
        stopId: string;
        authorizationEpoch: number;
        recordedAt: string;
        payload: Record<string, unknown>;
        payloadSha256: string;
        signature: string;
      };
    const authorizationEpoch = prior?.authorizationEpoch ?? (existing?.authorizationEpoch ?? 0) + 1;
    const committedAt = prior ? new Date(prior.recordedAt) : now();
    const reasonSha256 = createHash("sha256").update(input.request.reason).digest("hex");
    const localSigned = prior ? {
      payload: prior.payload,
      payloadSha256: prior.payloadSha256,
      signature: prior.signature,
    } : signRestrictedCicdLocalStopReceipt({
      stopId: input.request.stopId,
      environment: input.request.environment,
      authorizationEpoch,
      actorKind,
      actorIdentity: input.request.actorIdentity,
      actorFingerprintSha256: input.actorFingerprintSha256,
      reasonSha256,
      committedAt,
      receiptNonce: `${input.request.stopId}-local-stop-committed`,
      keyId: input.receiptKeyId,
      privateKey: input.receiptPrivateKey,
    });
    const local = await input.journal.appendLocalStop({
      environment: input.request.environment,
      stopId: input.request.stopId,
      authorizationEpoch,
      actorKind,
      actorIdentity: input.request.actorIdentity,
      actorFingerprintSha256: input.actorFingerprintSha256,
      reason: input.request.reason,
      reasonSha256,
      recordedAt: committedAt,
      signed: localSigned,
    });
    await input.journal.removePendingLocalStopRequest(queued.document);
    let reservation: Awaited<ReturnType<TargetDatabase["requestStop"]>>;
    try {
      reservation = await input.database.requestStop(input.request);
    } catch {
      return {
        phase: "stop_committed" as const,
        generation: authorizationEpoch,
        authorizationEpoch,
        pendingBackfill: true,
        replayed: local.replayed,
      };
    }
    const generated = signRestrictedCicdStopReceipt({
      stopId: input.request.stopId,
      environment: input.request.environment,
      generation: reservation.generation,
      phase: "stop_committed",
      activationId: null,
      expectedCurrentReleaseVersionId: reservation.expectedCurrentReleaseVersionId,
      requestedAt: reservation.requestedAt,
      receiptNonce: `${input.request.stopId}-stop-committed`,
      keyId: input.receiptKeyId,
      actorKind,
      actorFingerprintSha256: input.actorFingerprintSha256,
      privateKey: input.receiptPrivateKey,
    });
    const receiptId = `${input.request.stopId}-receipt-stop-committed`;
    const persisted = await input.journal.saveLocalStopPlatformReceipt({
      environment: input.request.environment,
      stopId: input.request.stopId,
      authorizationEpoch,
      receiptId,
      receiptPhase: "stop_committed",
      recordedAt: now(),
      signed: generated,
    });
    const persistedKeyId = persisted.signed.payload.keyId;
    if (typeof persistedKeyId !== "string") throw new Error("persisted stop receipt key invalid");
    let receipt: { receiptId: string; replayed: boolean };
    try {
      receipt = await input.database.appendStopReceipt({
        receiptId,
        signed: persisted.signed,
        publicKey: input.receiptPublicKeyFor(persistedKeyId, persisted.recordedAt),
        receiptTrustSha256: input.receiptTrustSha256,
      });
    } catch {
      return {
        phase: "stop_committed" as const,
        generation: reservation.generation,
        authorizationEpoch,
        pendingBackfill: true,
        replayed: local.replayed || reservation.replayed,
      };
    }
    await input.journal.appendLocalStopBackfill({
      environment: input.request.environment,
      stopId: input.request.stopId,
      authorizationEpoch,
      platformReceiptSha256: persisted.signed.payloadSha256,
      recordedAt: now(),
    });
    return {
      phase: "stop_committed" as const,
      generation: reservation.generation,
      authorizationEpoch,
      pendingBackfill: false,
      replayed: local.replayed || reservation.replayed || receipt.replayed,
    };
  });
}
