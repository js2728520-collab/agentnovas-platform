import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { TargetOperationIdentity } from "./restricted-cicd-domain.ts";

type JsonObject = Record<string, unknown>;
export type TargetJournalEnvironment = "staging" | "production";
export type TargetJournalPhase =
  | "prepared"
  | "applying"
  | "cutover_intent_durable"
  | "cutover_committed"
  | "health_verified"
  | "health_failed_after_cutover"
  | "failed_before_cutover"
  | "uncertain_before_cutover"
  | "uncertain_after_cutover"
  | "stop_committed";

type TargetCheckpoint = {
  sequence: number;
  phase: TargetJournalPhase;
  ownerEpoch: number;
  idempotencyKey: string;
  evidenceSha256: string;
  recordedAt: string;
  actualPreviousReleaseVersionId: string | null;
  actualCurrentReleaseVersionId: string | null;
};

type TargetJournalDocument = {
  schemaVersion: "1";
  operationId: string;
  commandId: string;
  environment: TargetJournalEnvironment;
  currentOwnerEpoch: number;
  sequence: number;
  checkpoints: TargetCheckpoint[];
  ownershipTransfers: TargetOwnershipTransfer[];
  receipts: Record<string, TargetStoredReceipt>;
};

type TargetStoredReceipt = {
  payload: JsonObject;
  payloadSha256: string;
  signature: string;
};

type TargetOwnershipTransfer = {
  previousOwnerEpoch: number;
  ownerEpoch: number;
  ownerIdentitySha256: string;
  evidenceSha256: string;
  reason: string;
  recordedAt: string;
};

type LockDocument = {
  schemaVersion: "1";
  environment: TargetJournalEnvironment;
  operationId: string;
  ownerEpoch: number;
  ownerIdentitySha256: string;
  processId: number;
  processIdentitySha256: string;
  acquiredAt: string;
};

type LocalStopCommittedEvent = {
  phase: "stop_committed";
  stopId: string;
  authorizationEpoch: number;
  actorKind: "target" | "break_glass";
  actorIdentity: string;
  actorFingerprintSha256: string;
  reason: string;
  reasonSha256: string;
  recordedAt: string;
  payload: JsonObject;
  payloadSha256: string;
  signature: string;
};

type LocalStopBackfillEvent = {
  phase: "platform_backfilled";
  stopId: string;
  authorizationEpoch: number;
  platformReceiptSha256: string;
  recordedAt: string;
};

type LocalStopPlatformReceiptEvent = {
  phase: "platform_receipt_prepared";
  stopId: string;
  authorizationEpoch: number;
  receiptId: string;
  receiptPhase: "stop_committed" | "clear_acknowledged";
  recordedAt: string;
  payload: JsonObject;
  payloadSha256: string;
  signature: string;
};

type LocalStopClearEvent = {
  phase: "clear_acknowledged";
  stopId: string;
  authorizationEpoch: number;
  activationId: string;
  recordedAt: string;
  payload: JsonObject;
  payloadSha256: string;
  signature: string;
};

type LocalStopEvent = LocalStopCommittedEvent | LocalStopBackfillEvent
  | LocalStopPlatformReceiptEvent | LocalStopClearEvent;

type LocalStopDocument = {
  schemaVersion: "1";
  environment: TargetJournalEnvironment;
  authorizationEpoch: number;
  events: LocalStopEvent[];
};

type PendingLocalStopRequest = {
  schemaVersion: "1";
  request: {
    schemaVersion: "1";
    stopId: string;
    environment: TargetJournalEnvironment;
    actorKind: "user" | "break_glass";
    actorIdentity: string;
    reason: string;
  };
  actorFingerprintSha256: string;
  requestedAt: string;
};

type ReceiptTrustVerificationKey = {
  keyId: string;
  spkiSha256: string;
  publicKeySpkiBase64: string;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
  compromisedAt: string | null;
  verificationPublicKey: KeyObject;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PHASES = new Set<TargetJournalPhase>([
  "prepared", "applying", "cutover_intent_durable", "cutover_committed", "health_verified",
  "health_failed_after_cutover", "failed_before_cutover", "uncertain_before_cutover",
  "uncertain_after_cutover", "stop_committed",
]);
const RECEIPT_PHASES = new Set<TargetJournalPhase>([
  "cutover_committed", "health_verified", "health_failed_after_cutover",
  "failed_before_cutover", "uncertain_before_cutover", "uncertain_after_cutover",
  "stop_committed",
]);
const TRANSITIONS = new Map<TargetJournalPhase | null, Set<TargetJournalPhase>>([
  [null, new Set(["prepared", "stop_committed"])],
  ["prepared", new Set(["applying", "failed_before_cutover", "uncertain_before_cutover", "stop_committed"])],
  ["applying", new Set(["cutover_intent_durable", "failed_before_cutover", "uncertain_before_cutover", "stop_committed"])],
  ["cutover_intent_durable", new Set(["cutover_committed", "uncertain_before_cutover", "uncertain_after_cutover", "stop_committed"])],
  ["cutover_committed", new Set(["health_verified", "health_failed_after_cutover", "uncertain_after_cutover", "stop_committed"])],
  ["health_verified", new Set()],
  ["health_failed_after_cutover", new Set()],
  ["failed_before_cutover", new Set()],
  ["uncertain_before_cutover", new Set()],
  ["uncertain_after_cutover", new Set()],
  ["stop_committed", new Set()],
]);

export class RestrictedCicdTargetJournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RestrictedCicdTargetJournalError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RestrictedCicdTargetJournalError(code, message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeName(value: string, field: string) {
  if (!IDENTIFIER.test(value)) return fail("TARGET_JOURNAL_INVALID", `Invalid ${field}`);
  return value;
}

function safeEpoch(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) return fail("TARGET_JOURNAL_INVALID", "Invalid owner epoch");
  return value;
}

function environmentName(value: string): TargetJournalEnvironment {
  if (value !== "staging" && value !== "production") return fail("TARGET_JOURNAL_INVALID", "Invalid environment");
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("TARGET_CANONICAL_JSON_INVALID", "Non-finite receipt value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return fail("TARGET_CANONICAL_JSON_INVALID", "Unsupported receipt value");
}

export function canonicalizeRestrictedCicdReceipt(value: unknown) {
  return canonicalJson(value);
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath: string, value: unknown) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const body = `${canonicalJson(value)}\n`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function parseCheckpoint(value: unknown): TargetCheckpoint {
  if (!isObject(value)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || typeof value.phase !== "string" || !PHASES.has(value.phase as TargetJournalPhase)
    || !Number.isSafeInteger(value.ownerEpoch) || Number(value.ownerEpoch) < 1
    || typeof value.idempotencyKey !== "string" || !IDENTIFIER.test(value.idempotencyKey)
    || typeof value.evidenceSha256 !== "string" || !SHA256.test(value.evidenceSha256)
    || !exactIso(value.recordedAt)
    || (value.actualPreviousReleaseVersionId !== null && !IDENTIFIER.test(String(value.actualPreviousReleaseVersionId)))
    || (value.actualCurrentReleaseVersionId !== null && !IDENTIFIER.test(String(value.actualCurrentReleaseVersionId)))) {
    return fail("TARGET_JOURNAL_CORRUPT", "Target journal checkpoint corrupt");
  }
  return value as TargetCheckpoint;
}

function parseJournal(value: unknown): TargetJournalDocument {
  if (!isObject(value) || value.schemaVersion !== "1"
    || typeof value.operationId !== "string" || !IDENTIFIER.test(value.operationId)
    || typeof value.commandId !== "string" || !IDENTIFIER.test(value.commandId)
    || (value.environment !== "staging" && value.environment !== "production")
    || !Number.isSafeInteger(value.currentOwnerEpoch) || Number(value.currentOwnerEpoch) < 1
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || !Array.isArray(value.checkpoints) || value.checkpoints.length < 1 || value.checkpoints.length > 100
    || !Array.isArray(value.ownershipTransfers) || value.ownershipTransfers.length > 20
    || !isObject(value.receipts) || Object.keys(value.receipts).length > 20) {
    return fail("TARGET_JOURNAL_CORRUPT", "Target journal corrupt");
  }
  const checkpoints = value.checkpoints.map(parseCheckpoint);
  const ownershipTransfers = value.ownershipTransfers.map((transfer) => {
    if (!isObject(transfer)
      || !Number.isSafeInteger(transfer.previousOwnerEpoch) || Number(transfer.previousOwnerEpoch) < 1
      || !Number.isSafeInteger(transfer.ownerEpoch)
      || Number(transfer.ownerEpoch) !== Number(transfer.previousOwnerEpoch) + 1
      || typeof transfer.ownerIdentitySha256 !== "string" || !SHA256.test(transfer.ownerIdentitySha256)
      || typeof transfer.evidenceSha256 !== "string" || !SHA256.test(transfer.evidenceSha256)
      || typeof transfer.reason !== "string" || transfer.reason.length < 10 || transfer.reason.length > 500
      || !exactIso(transfer.recordedAt)) {
      return fail("TARGET_JOURNAL_CORRUPT", "Target journal ownership transfer corrupt");
    }
    return transfer as TargetOwnershipTransfer;
  });
  const receipts = Object.fromEntries(Object.entries(value.receipts).map(([receiptId, receipt]) => {
    if (!IDENTIFIER.test(receiptId) || !isObject(receipt) || !isObject(receipt.payload)
      || typeof receipt.payloadSha256 !== "string" || !SHA256.test(receipt.payloadSha256)
      || createHash("sha256").update(canonicalJson(receipt.payload)).digest("hex") !== receipt.payloadSha256
      || typeof receipt.signature !== "string" || receipt.signature.length < 40 || receipt.signature.length > 500) {
      return fail("TARGET_JOURNAL_CORRUPT", "Target journal receipt corrupt");
    }
    return [receiptId, receipt as TargetStoredReceipt];
  }));
  if (checkpoints.some((checkpoint, index) => checkpoint.sequence !== index + 1)
    || checkpoints.at(-1)?.sequence !== value.sequence
    || checkpoints.some((checkpoint, index) => checkpoint.ownerEpoch > Number(value.currentOwnerEpoch)
      || (index > 0 && checkpoint.ownerEpoch < checkpoints[index - 1].ownerEpoch))
    || ownershipTransfers.some((transfer, index) => transfer.previousOwnerEpoch !== index + 1)
    || Number(value.currentOwnerEpoch) !== ownershipTransfers.length + 1) {
    return fail("TARGET_JOURNAL_CORRUPT", "Target journal sequence corrupt");
  }
  return { ...value, checkpoints, ownershipTransfers, receipts } as TargetJournalDocument;
}

function parseLock(value: unknown): LockDocument {
  if (!isObject(value) || value.schemaVersion !== "1"
    || (value.environment !== "staging" && value.environment !== "production")
    || typeof value.operationId !== "string" || !IDENTIFIER.test(value.operationId)
    || !Number.isSafeInteger(value.ownerEpoch) || Number(value.ownerEpoch) < 1
    || typeof value.ownerIdentitySha256 !== "string" || !SHA256.test(value.ownerIdentitySha256)
    || !Number.isSafeInteger(value.processId) || Number(value.processId) < 1
    || typeof value.processIdentitySha256 !== "string" || !SHA256.test(value.processIdentitySha256)
    || !exactIso(value.acquiredAt)) {
    return fail("TARGET_MUTEX_CORRUPT", "Target environment mutex corrupt");
  }
  return value as LockDocument;
}

function parseLocalStop(value: unknown): LocalStopDocument {
  if (!isObject(value) || value.schemaVersion !== "1"
    || (value.environment !== "staging" && value.environment !== "production")
    || !Number.isSafeInteger(value.authorizationEpoch) || Number(value.authorizationEpoch) < 1
    || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 1_000) {
    return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local stop journal corrupt");
  }
  let epoch = 0;
  let activeStopId: string | null = null;
  const committedStops = new Map<string, number>();
  const events = value.events.map((event): LocalStopEvent => {
    if (!isObject(event) || typeof event.phase !== "string" || !IDENTIFIER.test(String(event.stopId))
      || !Number.isSafeInteger(event.authorizationEpoch) || Number(event.authorizationEpoch) < 1
      || !exactIso(event.recordedAt)) {
      return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local stop event corrupt");
    }
    if (event.phase === "stop_committed") {
      if (Number(event.authorizationEpoch) !== epoch + 1
        || (event.actorKind !== "target" && event.actorKind !== "break_glass")
        || typeof event.actorIdentity !== "string" || !IDENTIFIER.test(event.actorIdentity)
        || typeof event.actorFingerprintSha256 !== "string" || !SHA256.test(event.actorFingerprintSha256)
        || typeof event.reason !== "string" || event.reason.length < 8 || event.reason.length > 500
        || typeof event.reasonSha256 !== "string" || !SHA256.test(event.reasonSha256)
        || createHash("sha256").update(event.reason).digest("hex") !== event.reasonSha256
        || !isObject(event.payload) || typeof event.payloadSha256 !== "string" || !SHA256.test(event.payloadSha256)
        || typeof event.signature !== "string" || event.signature.length < 40 || event.signature.length > 500
        || createHash("sha256").update(canonicalJson(event.payload)).digest("hex") !== event.payloadSha256) {
        return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local stop event corrupt");
      }
      epoch = Number(event.authorizationEpoch);
      activeStopId = String(event.stopId);
      committedStops.set(activeStopId, epoch);
      return event as LocalStopCommittedEvent;
    }
    if (event.phase === "platform_backfilled") {
      if (committedStops.get(String(event.stopId)) !== Number(event.authorizationEpoch)
        || typeof event.platformReceiptSha256 !== "string" || !SHA256.test(event.platformReceiptSha256)) {
        return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local stop backfill corrupt");
      }
      return event as LocalStopBackfillEvent;
    }
    if (event.phase === "platform_receipt_prepared") {
      if (committedStops.get(String(event.stopId)) !== Number(event.authorizationEpoch)
        || typeof event.receiptId !== "string" || !IDENTIFIER.test(event.receiptId)
        || (event.receiptPhase !== "stop_committed" && event.receiptPhase !== "clear_acknowledged")
        || !isObject(event.payload) || typeof event.payloadSha256 !== "string"
        || !SHA256.test(event.payloadSha256)
        || typeof event.signature !== "string" || event.signature.length < 40 || event.signature.length > 500
        || createHash("sha256").update(canonicalJson(event.payload)).digest("hex") !== event.payloadSha256
        || event.payload.kind !== "target_stop_receipt"
        || event.payload.stopId !== event.stopId || event.payload.environment !== value.environment
        || event.payload.phase !== event.receiptPhase
        || typeof event.payload.keyId !== "string" || !IDENTIFIER.test(event.payload.keyId)) {
        return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local platform receipt corrupt");
      }
      return event as LocalStopPlatformReceiptEvent;
    }
    if (event.phase === "clear_acknowledged") {
      if (Number(event.authorizationEpoch) !== epoch || String(event.stopId) !== activeStopId
        || typeof event.activationId !== "string" || !IDENTIFIER.test(event.activationId)
        || !isObject(event.payload) || typeof event.payloadSha256 !== "string" || !SHA256.test(event.payloadSha256)
        || typeof event.signature !== "string" || event.signature.length < 40 || event.signature.length > 500
        || createHash("sha256").update(canonicalJson(event.payload)).digest("hex") !== event.payloadSha256) {
        return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local stop clear event corrupt");
      }
      activeStopId = null;
      return event as LocalStopClearEvent;
    }
    return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local stop event corrupt");
  });
  if (epoch !== value.authorizationEpoch) {
    return fail("TARGET_LOCAL_STOP_CORRUPT", "Target-local stop epoch corrupt");
  }
  return { ...value, events } as LocalStopDocument;
}

function parsePendingLocalStopRequest(value: unknown): PendingLocalStopRequest {
  if (!isObject(value) || value.schemaVersion !== "1"
    || Object.keys(value).sort().join(",") !== "actorFingerprintSha256,request,requestedAt,schemaVersion"
    || !isObject(value.request)
    || Object.keys(value.request).sort().join(",")
      !== "actorIdentity,actorKind,environment,reason,schemaVersion,stopId"
    || value.request.schemaVersion !== "1"
    || typeof value.request.stopId !== "string" || !IDENTIFIER.test(value.request.stopId)
    || (value.request.environment !== "staging" && value.request.environment !== "production")
    || (value.request.actorKind !== "user" && value.request.actorKind !== "break_glass")
    || typeof value.request.actorIdentity !== "string" || !IDENTIFIER.test(value.request.actorIdentity)
    || typeof value.request.reason !== "string"
    || value.request.reason.length < 8 || value.request.reason.length > 500
    || typeof value.actorFingerprintSha256 !== "string" || !SHA256.test(value.actorFingerprintSha256)
    || !exactIso(value.requestedAt)) {
    return fail("TARGET_LOCAL_STOP_PENDING_CORRUPT", "Pending target-local stop request corrupt");
  }
  return value as PendingLocalStopRequest;
}

async function readJson(filePath: string) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 256 * 1024
    || (metadata.mode & 0o077) !== 0) {
    return fail("TARGET_JOURNAL_CORRUPT", "Target journal custody invalid");
  }
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function linuxProcessIdentity(processId: number) {
  const [bootId, processStat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${processId}/stat`, "utf8"),
  ]);
  const commandEnd = processStat.lastIndexOf(")");
  const fieldsAfterCommand = processStat.slice(commandEnd + 2).trim().split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  if (commandEnd < 1 || !/^[0-9]+$/.test(startTicks ?? "")) {
    return fail("TARGET_PROCESS_IDENTITY_INVALID", "Target process identity invalid");
  }
  return createHash("sha256")
    .update(bootId.trim()).update("\0").update(String(processId)).update("\0").update(startTicks)
    .digest("hex");
}

export async function createRestrictedCicdTargetJournal(root: string, dependencies: {
  processId?: number;
  processIdentitySha256?: string;
  isProcessAlive?: (lock: Readonly<LockDocument>) => Promise<boolean>;
} = {}) {
  if (!path.isAbsolute(root) || root.length > 500 || root.includes("\0")) {
    return fail("TARGET_JOURNAL_ROOT_INVALID", "Target journal root invalid");
  }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    return fail("TARGET_JOURNAL_ROOT_INVALID", "Target journal root invalid");
  }
  const operationsDirectory = path.join(root, "operations");
  const locksDirectory = path.join(root, "locks");
  const operationLocksDirectory = path.join(root, "operation-locks");
  const stopsDirectory = path.join(root, "stops");
  const pendingStopsDirectory = path.join(root, "pending-stops");
  await mkdir(operationsDirectory, { mode: 0o700, recursive: true });
  await mkdir(locksDirectory, { mode: 0o700, recursive: true });
  await mkdir(operationLocksDirectory, { mode: 0o700, recursive: true });
  await mkdir(stopsDirectory, { mode: 0o700, recursive: true });
  await mkdir(pendingStopsDirectory, { mode: 0o700, recursive: true });
  for (const directory of [
    operationsDirectory, locksDirectory, operationLocksDirectory, stopsDirectory, pendingStopsDirectory,
  ]) {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()
      || (directoryMetadata.mode & 0o077) !== 0) {
      return fail("TARGET_JOURNAL_ROOT_INVALID", "Target journal directory custody invalid");
    }
  }
  const processId = dependencies.processId ?? process.pid;
  const processIdentitySha256 = dependencies.processIdentitySha256
    ?? (process.platform === "linux"
      ? await linuxProcessIdentity(processId)
      : createHash("sha256").update(`non-linux-process:${process.platform}:${processId}`).digest("hex"));
  if (!Number.isSafeInteger(processId) || processId < 1 || !SHA256.test(processIdentitySha256)) {
    return fail("TARGET_PROCESS_IDENTITY_INVALID", "Target process identity invalid");
  }
  const isProcessAlive = dependencies.isProcessAlive ?? (async (lock: Readonly<LockDocument>) => {
    try {
      return await linuxProcessIdentity(lock.processId) === lock.processIdentitySha256;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  });

  function journalPath(operationId: string) {
    return path.join(operationsDirectory, `${safeName(operationId, "operation id")}.json`);
  }

  async function load(operationId: string) {
    try {
      return parseJournal(await readJson(journalPath(operationId)));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  function localStopPath(environment: TargetJournalEnvironment) {
    return path.join(stopsDirectory, `${environmentName(environment)}.json`);
  }

  async function loadLocalStop(environmentInput: TargetJournalEnvironment) {
    const environment = environmentName(environmentInput);
    try {
      return parseLocalStop(await readJson(localStopPath(environment)));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  function pendingLocalStopPath(environment: TargetJournalEnvironment) {
    return path.join(pendingStopsDirectory, `${environmentName(environment)}.json`);
  }

  async function loadPendingLocalStop(environmentInput: TargetJournalEnvironment) {
    const environment = environmentName(environmentInput);
    try {
      return parsePendingLocalStopRequest(await readJson(pendingLocalStopPath(environment)));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function acquireLock(input: {
    environment: TargetJournalEnvironment;
    operationId: string;
    ownerEpoch: number;
    ownerIdentitySha256: string;
    now?: Date;
  }, namespace: "environment" | "operation" = "environment") {
    const environment = environmentName(input.environment);
    safeName(input.operationId, "operation id");
    safeEpoch(input.ownerEpoch);
    if (!SHA256.test(input.ownerIdentitySha256)) return fail("TARGET_JOURNAL_INVALID", "Invalid owner identity");
    const parentDirectory = namespace === "environment" ? locksDirectory : operationLocksDirectory;
    const lockName = namespace === "environment" ? environment : safeName(input.operationId, "operation id");
    const lockDirectory = path.join(parentDirectory, `${lockName}.lock`);
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        return fail("TARGET_MUTEX_BUSY", "Target environment mutex busy");
      }
      throw error;
    }
    const lock: LockDocument = {
      schemaVersion: "1",
      environment,
      operationId: input.operationId,
      ownerEpoch: input.ownerEpoch,
      ownerIdentitySha256: input.ownerIdentitySha256,
      processId,
      processIdentitySha256,
      acquiredAt: (input.now ?? new Date()).toISOString(),
    };
    try {
      await atomicWrite(path.join(lockDirectory, "owner.json"), lock);
      await syncDirectory(parentDirectory);
      return { lockDirectory, lock };
    } catch (error) {
      await rmdir(lockDirectory).catch(() => undefined);
      throw error;
    }
  }

  async function releaseLock(lockDirectory: string, expected: LockDocument) {
    const actual = parseLock(await readJson(path.join(lockDirectory, "owner.json")));
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      return fail("TARGET_OWNER_STALE", "Target mutex ownership changed before release");
    }
    await unlink(path.join(lockDirectory, "owner.json"));
    await rmdir(lockDirectory);
    await syncDirectory(path.dirname(lockDirectory));
  }

  function createSession(input: {
    environment: TargetJournalEnvironment;
    operationId: string;
    commandId: string;
    ownerEpoch: number;
  }) {
    return {
      load: () => load(input.operationId),
      async append(checkpoint: {
        phase: TargetJournalPhase;
        evidenceSha256: string;
        recordedAt: Date;
        actualPreviousReleaseVersionId: string | null;
        actualCurrentReleaseVersionId: string | null;
      }) {
        if (!PHASES.has(checkpoint.phase) || !SHA256.test(checkpoint.evidenceSha256)
          || !Number.isFinite(checkpoint.recordedAt.getTime())) {
          return fail("TARGET_JOURNAL_INVALID", "Target checkpoint invalid");
        }
        const existing = await load(input.operationId);
        const last = existing?.checkpoints.at(-1) ?? null;
        const idempotencyKey = `${input.operationId}-${checkpoint.phase}`;
        const next: TargetCheckpoint = {
          sequence: (existing?.sequence ?? 0) + 1,
          phase: checkpoint.phase,
          ownerEpoch: input.ownerEpoch,
          idempotencyKey,
          evidenceSha256: checkpoint.evidenceSha256,
          recordedAt: checkpoint.recordedAt.toISOString(),
          actualPreviousReleaseVersionId: checkpoint.actualPreviousReleaseVersionId,
          actualCurrentReleaseVersionId: checkpoint.actualCurrentReleaseVersionId,
        };
        if (existing && (existing.commandId !== input.commandId || existing.environment !== input.environment
          || existing.currentOwnerEpoch !== input.ownerEpoch)) {
          return fail("TARGET_OWNER_STALE", "Target owner epoch stale");
        }
        if (last?.phase === checkpoint.phase) {
          const replayed = { ...last, sequence: next.sequence };
          const candidate = { ...next, sequence: next.sequence };
          if (canonicalJson(replayed) !== canonicalJson(candidate)) {
            return fail("TARGET_CHECKPOINT_REPLAY_MISMATCH", "Target checkpoint replay mismatch");
          }
          return { journal: existing as TargetJournalDocument, replayed: true };
        }
        if (!TRANSITIONS.get(last?.phase ?? null)?.has(checkpoint.phase)) {
          return fail("TARGET_PHASE_INVALID", "Target journal phase transition invalid");
        }
        const journal: TargetJournalDocument = existing
          ? { ...existing, sequence: next.sequence, checkpoints: [...existing.checkpoints, next] }
          : {
            schemaVersion: "1",
            operationId: input.operationId,
            commandId: input.commandId,
            environment: input.environment,
            currentOwnerEpoch: input.ownerEpoch,
            sequence: 1,
            checkpoints: [next],
            ownershipTransfers: [],
            receipts: {},
          };
        await atomicWrite(journalPath(input.operationId), journal);
        return { journal, replayed: false };
      },
      async saveReceipt<T extends TargetStoredReceipt>(receiptId: string, signed: T) {
        safeName(receiptId, "receipt id");
        if (!isObject(signed.payload) || !SHA256.test(signed.payloadSha256)
          || createHash("sha256").update(canonicalJson(signed.payload)).digest("hex") !== signed.payloadSha256
          || typeof signed.signature !== "string" || signed.signature.length < 40 || signed.signature.length > 500) {
          return fail("TARGET_RECEIPT_INVALID", "Target stored receipt invalid");
        }
        const existing = await load(input.operationId);
        if (!existing || existing.commandId !== input.commandId || existing.environment !== input.environment
          || existing.currentOwnerEpoch !== input.ownerEpoch) {
          return fail("TARGET_OWNER_STALE", "Target owner epoch stale");
        }
        const prior = existing.receipts[receiptId];
        if (prior) {
          if (canonicalJson(prior) !== canonicalJson(signed)) {
            return fail("TARGET_RECEIPT_REPLAY_MISMATCH", "Target stored receipt replay mismatch");
          }
          return { journal: existing, replayed: true, signed: prior as T };
        }
        const journal = { ...existing, receipts: { ...existing.receipts, [receiptId]: signed } };
        await atomicWrite(journalPath(input.operationId), journal);
        return { journal, replayed: false, signed };
      },
    };
  }

  return {
    load,
    loadLocalStop,
    async enqueueLocalStopRequest(input: {
      request: PendingLocalStopRequest["request"];
      actorFingerprintSha256: string;
      requestedAt: Date;
    }) {
      const candidate = parsePendingLocalStopRequest({
        schemaVersion: "1",
        request: input.request,
        actorFingerprintSha256: input.actorFingerprintSha256,
        requestedAt: input.requestedAt.toISOString(),
      });
      const local = await loadLocalStop(candidate.request.environment);
      const active = [...(local?.events ?? [])].reverse()
        .find((event) => event.phase === "stop_committed" || event.phase === "clear_acknowledged");
      if (active?.phase === "stop_committed") {
        if (active.stopId !== candidate.request.stopId) {
          return fail("TARGET_LOCAL_STOP_ALREADY_ACTIVE", "A different target-local stop is already active");
        }
        const actorKind = candidate.request.actorKind === "break_glass" ? "break_glass" : "target";
        if (active.actorKind !== actorKind
          || active.actorIdentity !== candidate.request.actorIdentity
          || active.actorFingerprintSha256 !== candidate.actorFingerprintSha256
          || active.reason !== candidate.request.reason) {
          return fail("TARGET_LOCAL_STOP_REPLAY_MISMATCH", "Target-local stop replay mismatch");
        }
      }
      const existing = await loadPendingLocalStop(candidate.request.environment);
      if (existing) {
        const sameRequest = canonicalJson(existing.request) === canonicalJson(candidate.request)
          && existing.actorFingerprintSha256 === candidate.actorFingerprintSha256;
        if (!sameRequest) {
          return fail("TARGET_LOCAL_STOP_ALREADY_PENDING", "A different target-local stop is already pending");
        }
        return { document: existing, replayed: true };
      }
      await atomicWrite(pendingLocalStopPath(candidate.request.environment), candidate);
      return { document: candidate, replayed: false };
    },
    async listPendingLocalStopRequests(environmentInput: TargetJournalEnvironment) {
      const pending = await loadPendingLocalStop(environmentName(environmentInput));
      return pending ? [pending] : [];
    },
    async removePendingLocalStopRequest(expected: PendingLocalStopRequest) {
      const parsedExpected = parsePendingLocalStopRequest(expected);
      const filePath = pendingLocalStopPath(parsedExpected.request.environment);
      const actual = await loadPendingLocalStop(parsedExpected.request.environment);
      if (!actual || canonicalJson(actual) !== canonicalJson(parsedExpected)) {
        return fail("TARGET_LOCAL_STOP_PENDING_STALE", "Pending target-local stop request changed");
      }
      await unlink(filePath);
      await syncDirectory(pendingStopsDirectory);
    },
    async listJournals(environmentInput: TargetJournalEnvironment) {
      const environment = environmentName(environmentInput);
      const entries = await readdir(operationsDirectory, { withFileTypes: true });
      if (entries.length > 1_000) return fail("TARGET_JOURNAL_CORRUPT", "Too many target journals");
      const journals: TargetJournalDocument[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const operationId = entry.name.slice(0, -5);
        safeName(operationId, "operation id");
        const journal = await load(operationId);
        if (journal?.environment === environment) journals.push(journal);
      }
      return journals.sort((left, right) => left.operationId.localeCompare(right.operationId));
    },
    async appendLocalStop(input: {
      environment: TargetJournalEnvironment;
      stopId: string;
      authorizationEpoch: number;
      actorKind: "target" | "break_glass";
      actorIdentity: string;
      actorFingerprintSha256: string;
      reason: string;
      reasonSha256: string;
      recordedAt: Date;
      signed: { payload: JsonObject; payloadSha256: string; signature: string };
    }) {
      const environment = environmentName(input.environment);
      safeName(input.stopId, "stop id");
      safeEpoch(input.authorizationEpoch);
      if ((input.actorKind !== "target" && input.actorKind !== "break_glass")
        || !IDENTIFIER.test(input.actorIdentity)
        || !SHA256.test(input.actorFingerprintSha256) || !SHA256.test(input.reasonSha256)
        || typeof input.reason !== "string" || input.reason.length < 8 || input.reason.length > 500
        || createHash("sha256").update(input.reason).digest("hex") !== input.reasonSha256
        || !Number.isFinite(input.recordedAt.getTime()) || !isObject(input.signed.payload)
        || !SHA256.test(input.signed.payloadSha256)
        || createHash("sha256").update(canonicalJson(input.signed.payload)).digest("hex")
          !== input.signed.payloadSha256
        || input.signed.payload.kind !== "target_local_stop_receipt"
        || input.signed.payload.environment !== environment
        || input.signed.payload.stopId !== input.stopId
        || input.signed.payload.authorizationEpoch !== input.authorizationEpoch
        || input.signed.payload.actorKind !== input.actorKind
        || input.signed.payload.actorIdentity !== input.actorIdentity
        || input.signed.payload.actorFingerprintSha256 !== input.actorFingerprintSha256
        || input.signed.payload.reasonSha256 !== input.reasonSha256) {
        return fail("TARGET_LOCAL_STOP_INVALID", "Target-local stop invalid");
      }
      const existing = await loadLocalStop(environment);
      const prior = existing?.events.find((event) => event.phase === "stop_committed"
        && event.stopId === input.stopId) as LocalStopCommittedEvent | undefined;
      const event: LocalStopCommittedEvent = {
        phase: "stop_committed",
        stopId: input.stopId,
        authorizationEpoch: input.authorizationEpoch,
        actorKind: input.actorKind,
        actorIdentity: input.actorIdentity,
        actorFingerprintSha256: input.actorFingerprintSha256,
        reason: input.reason,
        reasonSha256: input.reasonSha256,
        recordedAt: input.recordedAt.toISOString(),
        payload: input.signed.payload,
        payloadSha256: input.signed.payloadSha256,
        signature: input.signed.signature,
      };
      if (prior) {
        if (canonicalJson(prior) !== canonicalJson(event)) {
          return fail("TARGET_LOCAL_STOP_REPLAY_MISMATCH", "Target-local stop replay mismatch");
        }
        return { document: existing as LocalStopDocument, replayed: true };
      }
      const active = [...(existing?.events ?? [])].reverse()
        .find((candidate) => candidate.phase === "stop_committed" || candidate.phase === "clear_acknowledged");
      if (active?.phase === "stop_committed") {
        return fail("TARGET_LOCAL_STOP_ALREADY_ACTIVE", "A different target-local stop is already active");
      }
      if (input.authorizationEpoch !== (existing?.authorizationEpoch ?? 0) + 1) {
        return fail("TARGET_LOCAL_STOP_EPOCH_STALE", "Target-local stop epoch stale");
      }
      const document: LocalStopDocument = {
        schemaVersion: "1",
        environment,
        authorizationEpoch: input.authorizationEpoch,
        events: [...(existing?.events ?? []), event],
      };
      await atomicWrite(localStopPath(environment), document);
      return { document, replayed: false };
    },
    async saveLocalStopPlatformReceipt(input: {
      environment: TargetJournalEnvironment;
      stopId: string;
      authorizationEpoch: number;
      receiptId: string;
      receiptPhase: "stop_committed" | "clear_acknowledged";
      recordedAt: Date;
      signed: { payload: JsonObject; payloadSha256: string; signature: string };
    }) {
      const environment = environmentName(input.environment);
      safeName(input.stopId, "stop id");
      safeEpoch(input.authorizationEpoch);
      safeName(input.receiptId, "receipt id");
      if (!Number.isFinite(input.recordedAt.getTime()) || !isObject(input.signed.payload)
        || !SHA256.test(input.signed.payloadSha256)
        || createHash("sha256").update(canonicalJson(input.signed.payload)).digest("hex")
          !== input.signed.payloadSha256
        || typeof input.signed.signature !== "string" || input.signed.signature.length < 40
        || input.signed.signature.length > 500
        || input.signed.payload.kind !== "target_stop_receipt"
        || input.signed.payload.stopId !== input.stopId
        || input.signed.payload.environment !== environment
        || input.signed.payload.phase !== input.receiptPhase
        || typeof input.signed.payload.keyId !== "string" || !IDENTIFIER.test(input.signed.payload.keyId)) {
        return fail("TARGET_LOCAL_STOP_INVALID", "Target-local platform receipt invalid");
      }
      const existing = await loadLocalStop(environment);
      if (!existing || !existing.events.some((candidate) => candidate.phase === "stop_committed"
        && candidate.stopId === input.stopId && candidate.authorizationEpoch === input.authorizationEpoch)) {
        return fail("TARGET_LOCAL_STOP_EPOCH_STALE", "Target-local platform receipt stale");
      }
      const prepared: LocalStopPlatformReceiptEvent = {
        phase: "platform_receipt_prepared", stopId: input.stopId,
        authorizationEpoch: input.authorizationEpoch, receiptId: input.receiptId,
        receiptPhase: input.receiptPhase, recordedAt: input.recordedAt.toISOString(),
        payload: input.signed.payload, payloadSha256: input.signed.payloadSha256,
        signature: input.signed.signature,
      };
      const prior = existing.events.find((candidate) => candidate.phase === "platform_receipt_prepared"
        && candidate.receiptId === input.receiptId) as LocalStopPlatformReceiptEvent | undefined;
      if (prior) {
        const { keyId: priorKeyId, ...priorPayload } = prior.payload;
        const { keyId: candidateKeyId, ...candidatePayload } = input.signed.payload;
        if (typeof priorKeyId !== "string" || typeof candidateKeyId !== "string"
          || canonicalJson(priorPayload) !== canonicalJson(candidatePayload)
          || prior.stopId !== prepared.stopId || prior.authorizationEpoch !== prepared.authorizationEpoch
          || prior.receiptPhase !== prepared.receiptPhase) {
          return fail("TARGET_LOCAL_STOP_REPLAY_MISMATCH", "Target-local platform receipt replay mismatch");
        }
        return { document: existing, replayed: true, signed: {
          payload: prior.payload, payloadSha256: prior.payloadSha256, signature: prior.signature,
        }, recordedAt: new Date(prior.recordedAt) };
      }
      const document = { ...existing, events: [...existing.events, prepared] };
      await atomicWrite(localStopPath(environment), document);
      return { document, replayed: false, signed: input.signed, recordedAt: input.recordedAt };
    },
    async appendLocalStopBackfill(input: {
      environment: TargetJournalEnvironment;
      stopId: string;
      authorizationEpoch: number;
      platformReceiptSha256: string;
      recordedAt: Date;
    }) {
      const environment = environmentName(input.environment);
      safeName(input.stopId, "stop id");
      safeEpoch(input.authorizationEpoch);
      if (!SHA256.test(input.platformReceiptSha256) || !Number.isFinite(input.recordedAt.getTime())) {
        return fail("TARGET_LOCAL_STOP_INVALID", "Target-local stop backfill invalid");
      }
      const existing = await loadLocalStop(environment);
      if (!existing || !existing.events.some((event) => event.phase === "stop_committed"
        && event.stopId === input.stopId && event.authorizationEpoch === input.authorizationEpoch)) {
        return fail("TARGET_LOCAL_STOP_EPOCH_STALE", "Target-local stop backfill stale");
      }
      const event: LocalStopBackfillEvent = {
        phase: "platform_backfilled",
        stopId: input.stopId,
        authorizationEpoch: input.authorizationEpoch,
        platformReceiptSha256: input.platformReceiptSha256,
        recordedAt: input.recordedAt.toISOString(),
      };
      const prior = existing.events.find((candidate) => candidate.phase === "platform_backfilled"
        && candidate.stopId === input.stopId) as LocalStopBackfillEvent | undefined;
      if (prior) {
        if (prior.platformReceiptSha256 !== event.platformReceiptSha256) {
          return fail("TARGET_LOCAL_STOP_REPLAY_MISMATCH", "Target-local stop backfill replay mismatch");
        }
        return { document: existing, replayed: true };
      }
      const document = { ...existing, events: [...existing.events, event] };
      await atomicWrite(localStopPath(environment), document);
      return { document, replayed: false };
    },
    async listPendingLocalStopBackfills(environmentInput: TargetJournalEnvironment) {
      const document = await loadLocalStop(environmentName(environmentInput));
      if (!document) return [];
      const backfilled = new Set(document.events.filter((event) => event.phase === "platform_backfilled")
        .map((event) => `${event.stopId}:${event.authorizationEpoch}`));
      return document.events.filter((event): event is LocalStopCommittedEvent => event.phase === "stop_committed")
        .filter((event) => !backfilled.has(`${event.stopId}:${event.authorizationEpoch}`));
    },
    async appendLocalStopClear(input: {
      environment: TargetJournalEnvironment;
      stopId: string;
      authorizationEpoch: number;
      activationId: string;
      recordedAt: Date;
      signed: { payload: JsonObject; payloadSha256: string; signature: string };
    }) {
      const environment = environmentName(input.environment);
      safeName(input.stopId, "stop id");
      safeEpoch(input.authorizationEpoch);
      safeName(input.activationId, "activation id");
      if (!Number.isFinite(input.recordedAt.getTime()) || !isObject(input.signed.payload)
        || !SHA256.test(input.signed.payloadSha256)
        || createHash("sha256").update(canonicalJson(input.signed.payload)).digest("hex")
          !== input.signed.payloadSha256
        || input.signed.payload.kind !== "target_stop_receipt"
        || input.signed.payload.phase !== "clear_acknowledged"
        || input.signed.payload.stopId !== input.stopId
        || input.signed.payload.environment !== environment
        || input.signed.payload.activationId !== input.activationId) {
        return fail("TARGET_LOCAL_STOP_CLEAR_INVALID", "Target-local stop clear invalid");
      }
      const existing = await loadLocalStop(environment);
      if (!existing || existing.authorizationEpoch !== input.authorizationEpoch) {
        return fail("TARGET_LOCAL_STOP_EPOCH_STALE", "Target-local stop clear epoch stale");
      }
      const prior = existing.events.find((event) => event.phase === "clear_acknowledged"
        && event.stopId === input.stopId) as LocalStopClearEvent | undefined;
      const event: LocalStopClearEvent = {
        phase: "clear_acknowledged",
        stopId: input.stopId,
        authorizationEpoch: input.authorizationEpoch,
        activationId: input.activationId,
        recordedAt: input.recordedAt.toISOString(),
        payload: input.signed.payload,
        payloadSha256: input.signed.payloadSha256,
        signature: input.signed.signature,
      };
      if (prior) {
        if (canonicalJson(prior) !== canonicalJson(event)) {
          return fail("TARGET_LOCAL_STOP_REPLAY_MISMATCH", "Target-local stop clear replay mismatch");
        }
        return { document: existing, replayed: true };
      }
      const lastControl = [...existing.events].reverse()
        .find((candidate) => candidate.phase === "stop_committed" || candidate.phase === "clear_acknowledged");
      if (lastControl?.phase !== "stop_committed" || lastControl.stopId !== input.stopId
        || lastControl.authorizationEpoch !== input.authorizationEpoch) {
        return fail("TARGET_LOCAL_STOP_CLEAR_STALE", "Target-local stop is not active");
      }
      const document = { ...existing, events: [...existing.events, event] };
      await atomicWrite(localStopPath(environment), document);
      return { document, replayed: false };
    },
    isLocalStopActive(document: LocalStopDocument | null) {
      if (!document) return false;
      const lastControl = [...document.events].reverse()
        .find((event) => event.phase === "stop_committed" || event.phase === "clear_acknowledged");
      return lastControl?.phase === "stop_committed";
    },
    async listRecoverable(environmentInput: TargetJournalEnvironment) {
      const environment = environmentName(environmentInput);
      const entries = await readdir(operationsDirectory, { withFileTypes: true });
      if (entries.length > 1_000) return fail("TARGET_JOURNAL_CORRUPT", "Too many target journals");
      const recoverable: TargetJournalDocument[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const operationId = entry.name.slice(0, -5);
        safeName(operationId, "operation id");
        const journal = await load(operationId);
        const terminal = journal?.checkpoints.at(-1)?.phase;
        if (journal?.environment === environment && terminal && ![
          "failed_before_cutover", "uncertain_before_cutover", "health_verified",
          "health_failed_after_cutover", "uncertain_after_cutover", "stop_committed",
        ].includes(terminal)) recoverable.push(journal);
      }
      return recoverable.sort((left, right) => left.operationId.localeCompare(right.operationId));
    },
    async recoverOwnedStaleLock(environmentInput: TargetJournalEnvironment, ownerIdentitySha256: string) {
      const environment = environmentName(environmentInput);
      if (!SHA256.test(ownerIdentitySha256)) return fail("TARGET_JOURNAL_INVALID", "Invalid owner identity");
      const lockDirectory = path.join(locksDirectory, `${environment}.lock`);
      let lock: LockDocument;
      try {
        lock = parseLock(await readJson(path.join(lockDirectory, "owner.json")));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
      if (lock.ownerIdentitySha256 !== ownerIdentitySha256) {
        return fail("TARGET_TAKEOVER_REQUIRED", "Stale lock belongs to another target owner");
      }
      if (await isProcessAlive(lock)) {
        return fail("TARGET_PREVIOUS_OWNER_LIVE", "Previous target owner is still live");
      }
      await releaseLock(lockDirectory, lock);
      return true;
    },
    async recoverOwnedStaleOperationLock(operationId: string, ownerIdentitySha256: string) {
      safeName(operationId, "operation id");
      if (!SHA256.test(ownerIdentitySha256)) return fail("TARGET_JOURNAL_INVALID", "Invalid owner identity");
      const lockDirectory = path.join(operationLocksDirectory, `${operationId}.lock`);
      let lock: LockDocument;
      try {
        lock = parseLock(await readJson(path.join(lockDirectory, "owner.json")));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
      if (lock.operationId !== operationId || lock.ownerIdentitySha256 !== ownerIdentitySha256) {
        return fail("TARGET_TAKEOVER_REQUIRED", "Stale operation lock belongs to another target owner");
      }
      if (await isProcessAlive(lock)) {
        return fail("TARGET_PREVIOUS_OWNER_LIVE", "Previous target operation owner is still live");
      }
      await releaseLock(lockDirectory, lock);
      return true;
    },
    async withEnvironmentMutex<T>(input: {
      environment: TargetJournalEnvironment;
      operationId: string;
      ownerEpoch: number;
      ownerIdentitySha256: string;
      now?: Date;
    }, callback: () => Promise<T>) {
      const acquired = await acquireLock(input);
      try {
        return await callback();
      } finally {
        await releaseLock(acquired.lockDirectory, acquired.lock);
      }
    },
    async assertEnvironmentOwnership(input: {
      environment: TargetJournalEnvironment;
      operationId: string;
      ownerEpoch: number;
      ownerIdentitySha256: string;
    }) {
      const environment = environmentName(input.environment);
      safeName(input.operationId, "operation id");
      safeEpoch(input.ownerEpoch);
      if (!SHA256.test(input.ownerIdentitySha256)) {
        return fail("TARGET_JOURNAL_INVALID", "Invalid owner identity");
      }
      const actual = parseLock(await readJson(path.join(locksDirectory, `${environment}.lock`, "owner.json")));
      if (actual.environment !== environment || actual.operationId !== input.operationId
        || actual.ownerEpoch !== input.ownerEpoch
        || actual.ownerIdentitySha256 !== input.ownerIdentitySha256
        || actual.processId !== processId || actual.processIdentitySha256 !== processIdentitySha256) {
        return fail("TARGET_OWNER_STALE", "Target environment mutex ownership stale");
      }
      return true;
    },
    async withOperationLock<T>(input: {
      environment: TargetJournalEnvironment;
      operationId: string;
      commandId: string;
      ownerEpoch: number;
      ownerIdentitySha256: string;
      now?: Date;
    }, callback: (session: ReturnType<typeof createSession>) => Promise<T>) {
      safeName(input.commandId, "command id");
      const acquired = await acquireLock(input, "operation");
      try {
        return await callback(createSession(input));
      } finally {
        await releaseLock(acquired.lockDirectory, acquired.lock);
      }
    },
    async withEnvironmentLock<T>(input: {
      environment: TargetJournalEnvironment;
      operationId: string;
      commandId: string;
      ownerEpoch: number;
      ownerIdentitySha256: string;
      now?: Date;
    }, callback: (session: {
      load(): Promise<TargetJournalDocument | null>;
      append(checkpoint: {
        phase: TargetJournalPhase;
        evidenceSha256: string;
        recordedAt: Date;
        actualPreviousReleaseVersionId: string | null;
        actualCurrentReleaseVersionId: string | null;
      }): Promise<{ journal: TargetJournalDocument; replayed: boolean }>;
    }) => Promise<T>) {
      safeName(input.commandId, "command id");
      const acquired = await acquireLock(input);
      try {
        return await callback(createSession(input));
      } finally {
        await releaseLock(acquired.lockDirectory, acquired.lock);
      }
    },
    async takeoverAndWithEnvironmentLock<T>(input: {
      environment: TargetJournalEnvironment;
      operationId: string;
      commandId: string;
      expectedOwnerEpoch: number;
      newOwnerEpoch: number;
      newOwnerIdentitySha256: string;
      evidenceSha256: string;
      reason: string;
      now?: Date;
    }, dependencies: {
      confirmPreviousOwnerStopped(lock: Readonly<LockDocument>): Promise<boolean>;
      authorizeTakeover(): Promise<{ ownerEpoch: number; replayed: boolean }>;
    }, callback: (session: ReturnType<typeof createSession>) => Promise<T>) {
      const environment = environmentName(input.environment);
      safeName(input.operationId, "operation id");
      safeName(input.commandId, "command id");
      safeEpoch(input.expectedOwnerEpoch);
      safeEpoch(input.newOwnerEpoch);
      if (input.newOwnerEpoch !== input.expectedOwnerEpoch + 1
        || !SHA256.test(input.newOwnerIdentitySha256) || !SHA256.test(input.evidenceSha256)
        || typeof input.reason !== "string" || input.reason.length < 10 || input.reason.length > 500) {
        return fail("TARGET_TAKEOVER_INVALID", "Target ownership takeover invalid");
      }
      const lockDirectory = path.join(locksDirectory, `${environment}.lock`);
      const lock = parseLock(await readJson(path.join(lockDirectory, "owner.json")));
      if (lock.environment !== environment || lock.operationId !== input.operationId
        || (lock.ownerEpoch !== input.expectedOwnerEpoch && lock.ownerEpoch !== input.newOwnerEpoch)) {
        return fail("TARGET_TAKEOVER_STALE", "Target ownership takeover stale");
      }
      const journal = await load(input.operationId);
      if (!journal || journal.commandId !== input.commandId || journal.environment !== environment
        || (journal.currentOwnerEpoch !== input.expectedOwnerEpoch
          && journal.currentOwnerEpoch !== input.newOwnerEpoch)) {
        return fail("TARGET_TAKEOVER_STALE", "Target ownership takeover stale");
      }
      if (!await dependencies.confirmPreviousOwnerStopped(lock)) {
        return fail("TARGET_PREVIOUS_OWNER_LIVE", "Previous target owner is not confirmed stopped");
      }
      const authorization = await dependencies.authorizeTakeover();
      if (authorization.ownerEpoch !== input.newOwnerEpoch || typeof authorization.replayed !== "boolean") {
        return fail("TARGET_TAKEOVER_AUTHORIZATION_INVALID", "Target ownership takeover authorization invalid");
      }
      const acquiredAt = (input.now ?? new Date()).toISOString();
      const replacementLock: LockDocument = {
        schemaVersion: "1",
        environment,
        operationId: input.operationId,
        ownerEpoch: input.newOwnerEpoch,
        ownerIdentitySha256: input.newOwnerIdentitySha256,
        processId,
        processIdentitySha256,
        acquiredAt,
      };
      if (lock.ownerEpoch === input.expectedOwnerEpoch) {
        await atomicWrite(path.join(lockDirectory, "owner.json"), replacementLock);
      } else if (canonicalJson(lock) !== canonicalJson(replacementLock)) {
        return fail("TARGET_TAKEOVER_REPLAY_MISMATCH", "Target ownership takeover replay mismatch");
      }
      let updatedJournal = journal;
      if (journal.currentOwnerEpoch === input.expectedOwnerEpoch) {
        const transfer: TargetOwnershipTransfer = {
          previousOwnerEpoch: input.expectedOwnerEpoch,
          ownerEpoch: input.newOwnerEpoch,
          ownerIdentitySha256: input.newOwnerIdentitySha256,
          evidenceSha256: input.evidenceSha256,
          reason: input.reason,
          recordedAt: acquiredAt,
        };
        updatedJournal = {
          ...journal,
          currentOwnerEpoch: input.newOwnerEpoch,
          ownershipTransfers: [...journal.ownershipTransfers, transfer],
        };
        await atomicWrite(journalPath(input.operationId), updatedJournal);
      }
      try {
        return await callback(createSession({
          environment,
          operationId: input.operationId,
          commandId: input.commandId,
          ownerEpoch: input.newOwnerEpoch,
        }));
      } finally {
        await releaseLock(lockDirectory, replacementLock);
      }
    },
  };
}

export async function loadRestrictedCicdReceiptPrivateKey(filePath: string) {
  if (!path.isAbsolute(filePath) || filePath.length > 500 || filePath.includes("\0")) {
    return fail("TARGET_RECEIPT_KEY_UNAVAILABLE", "Target receipt key unavailable");
  }
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 64 || metadata.size > 16 * 1024
      || (metadata.mode & 0o377) !== 0) throw new Error("custody");
    const key = createPrivateKey(await readFile(filePath));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("type");
    return key;
  } catch {
    return fail("TARGET_RECEIPT_KEY_UNAVAILABLE", "Target receipt key unavailable");
  }
}

export function signRestrictedCicdTargetReceipt(input: {
  identity: TargetOperationIdentity;
  imageDigests: { client: string; operations: string; maintenance: string; runtime: string };
  migrationRegistrySha256: string;
  backupId: string | null;
  journalPhase: TargetJournalPhase;
  journalSequence: number;
  ownerEpoch: number;
  startedAt: Date;
  completedAt: Date;
  actualPreviousReleaseVersionId: string | null;
  actualCurrentReleaseVersionId: string | null;
  receiptNonce: string;
  keyId: string;
  privateKey: KeyObject;
}) {
  if (input.privateKey.asymmetricKeyType !== "ed25519" || !IDENTIFIER.test(input.receiptNonce)
    || !IDENTIFIER.test(input.keyId) || !SHA256.test(input.migrationRegistrySha256)
    || !Number.isSafeInteger(input.journalSequence) || input.journalSequence < 1
    || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1
    || !Number.isFinite(input.startedAt.getTime()) || !Number.isFinite(input.completedAt.getTime())
    || input.completedAt < input.startedAt || !RECEIPT_PHASES.has(input.journalPhase)
    || !Object.values(input.imageDigests).every((digest) => SHA256.test(digest))) {
    return fail("TARGET_RECEIPT_INVALID", "Target receipt invalid");
  }
  const payload = {
    kind: "target_deployment_receipt",
    schemaVersion: "1",
    ...input.identity,
    actualPreviousReleaseVersionId: input.actualPreviousReleaseVersionId,
    actualCurrentReleaseVersionId: input.actualCurrentReleaseVersionId,
    imageDigests: input.imageDigests,
    migrationRegistrySha256: input.migrationRegistrySha256,
    backupId: input.backupId,
    journalPhase: input.journalPhase,
    journalSequence: input.journalSequence,
    ownerEpoch: input.ownerEpoch,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    result: input.journalPhase,
    receiptNonce: input.receiptNonce,
    keyId: input.keyId,
  };
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical), input.privateKey).toString("base64");
  return {
    payload,
    payloadSha256: createHash("sha256").update(canonical).digest("hex"),
    signature,
  };
}

export type SignedRestrictedCicdTargetReceipt = ReturnType<typeof signRestrictedCicdTargetReceipt>;

export function verifyRestrictedCicdTargetReceiptSignature(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
) {
  if (publicKey.asymmetricKeyType !== "ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try {
    return verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function restrictedCicdReceiptPublicKey(privateKey: KeyObject) {
  return createPublicKey(privateKey);
}

export function computeRestrictedCicdReceiptTrustSha256(publicKey: KeyObject, keyId: string) {
  if (publicKey.asymmetricKeyType !== "ed25519" || !IDENTIFIER.test(keyId)) {
    return fail("TARGET_RECEIPT_KEY_INVALID", "Target receipt trust invalid");
  }
  const spkiSha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  return createHash("sha256").update(canonicalJson({
    kind: "restricted_cicd_receipt_trust",
    schemaVersion: "1",
    algorithm: "Ed25519",
    canonicalization: "agentnovas-canonical-json-v1",
    keys: [{ keyId, spkiSha256 }],
  })).digest("hex");
}

export async function loadRestrictedCicdReceiptTrustPolicy(
  filePath: string,
  publicKey: KeyObject,
  keyId: string,
  now = new Date(),
) {
  if (!path.isAbsolute(filePath) || filePath.length > 500 || filePath.includes("\0")
    || publicKey.asymmetricKeyType !== "ed25519" || !IDENTIFIER.test(keyId)
    || !Number.isFinite(now.getTime())) {
    return fail("TARGET_RECEIPT_TRUST_INVALID", "Target receipt trust policy invalid");
  }
  const value = await readJson(filePath);
  if (!isObject(value) || value.schemaVersion !== "1" || value.algorithm !== "Ed25519"
    || value.canonicalization !== "agentnovas-canonical-json-v1"
    || Object.keys(value).sort().join(",") !== "algorithm,canonicalization,keys,schemaVersion"
    || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 3) {
    return fail("TARGET_RECEIPT_TRUST_INVALID", "Target receipt trust policy invalid");
  }
  const seen = new Set<string>();
  const keys = value.keys.map((candidate) => {
    if (!isObject(candidate)
      || Object.keys(candidate).sort().join(",")
        !== "compromisedAt,keyId,notAfter,notBefore,publicKeySpkiBase64,revokedAt,spkiSha256"
      || typeof candidate.keyId !== "string" || !IDENTIFIER.test(candidate.keyId) || seen.has(candidate.keyId)
      || typeof candidate.spkiSha256 !== "string" || !SHA256.test(candidate.spkiSha256)
      || typeof candidate.publicKeySpkiBase64 !== "string"
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.publicKeySpkiBase64)
      || !exactIso(candidate.notBefore) || !exactIso(candidate.notAfter)
      || (candidate.revokedAt !== null && !exactIso(candidate.revokedAt))
      || (candidate.compromisedAt !== null && !exactIso(candidate.compromisedAt))) {
      return fail("TARGET_RECEIPT_TRUST_INVALID", "Target receipt trust key invalid");
    }
    seen.add(candidate.keyId);
    const notBefore = new Date(candidate.notBefore);
    const notAfter = new Date(candidate.notAfter);
    if (notBefore >= notAfter
      || (candidate.revokedAt !== null && new Date(candidate.revokedAt) < notBefore)
      || (candidate.compromisedAt !== null && new Date(candidate.compromisedAt) < notBefore)) {
      return fail("TARGET_RECEIPT_TRUST_INVALID", "Target receipt trust key lifecycle invalid");
    }
    let verificationPublicKey: KeyObject;
    try {
      verificationPublicKey = createPublicKey({
        key: Buffer.from(candidate.publicKeySpkiBase64, "base64"), format: "der", type: "spki",
      });
    } catch {
      return fail("TARGET_RECEIPT_TRUST_INVALID", "Target receipt trust public key invalid");
    }
    const boundSpkiSha256 = createHash("sha256")
      .update(verificationPublicKey.export({ type: "spki", format: "der" })).digest("hex");
    if (verificationPublicKey.asymmetricKeyType !== "ed25519"
      || boundSpkiSha256 !== candidate.spkiSha256) {
      return fail("TARGET_RECEIPT_TRUST_INVALID", "Target receipt trust public key mismatch");
    }
    return { ...candidate, verificationPublicKey } as ReceiptTrustVerificationKey;
  });
  const spkiSha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const active = keys.find((candidate) => candidate.keyId === keyId);
  if (!active || active.spkiSha256 !== spkiSha256 || now < new Date(String(active.notBefore))
    || now >= new Date(String(active.notAfter)) || active.revokedAt !== null || active.compromisedAt !== null) {
    return fail("TARGET_RECEIPT_KEY_INACTIVE", "Target receipt signing key inactive");
  }
  return {
    policy: value,
    sha256: createHash("sha256").update(canonicalJson(value)).digest("hex"),
    verificationPublicKeyFor(verificationKeyId: string, signedAt: Date) {
      if (!IDENTIFIER.test(verificationKeyId) || !Number.isFinite(signedAt.getTime())) {
        return fail("TARGET_RECEIPT_KEY_INACTIVE", "Target receipt verification key inactive");
      }
      const candidate = keys.find((item) => item.keyId === verificationKeyId);
      if (!candidate || signedAt < new Date(String(candidate.notBefore))
        || signedAt >= new Date(String(candidate.notAfter))
        || (candidate.revokedAt !== null && signedAt >= new Date(String(candidate.revokedAt)))
        || candidate.compromisedAt !== null) {
        return fail("TARGET_RECEIPT_KEY_INACTIVE", "Target receipt verification key inactive");
      }
      return candidate.verificationPublicKey;
    },
  };
}

export function signRestrictedCicdLocalStopReceipt(input: {
  stopId: string;
  environment: TargetJournalEnvironment;
  authorizationEpoch: number;
  actorKind: "target" | "break_glass";
  actorIdentity: string;
  actorFingerprintSha256: string;
  reasonSha256: string;
  committedAt: Date;
  receiptNonce: string;
  keyId: string;
  privateKey: KeyObject;
}) {
  if (!IDENTIFIER.test(input.stopId) || !Number.isSafeInteger(input.authorizationEpoch)
    || input.authorizationEpoch < 1 || (input.actorKind !== "target" && input.actorKind !== "break_glass")
    || !IDENTIFIER.test(input.actorIdentity)
    || !SHA256.test(input.actorFingerprintSha256) || !SHA256.test(input.reasonSha256)
    || !Number.isFinite(input.committedAt.getTime()) || !IDENTIFIER.test(input.receiptNonce)
    || !IDENTIFIER.test(input.keyId) || input.privateKey.asymmetricKeyType !== "ed25519") {
    return fail("TARGET_LOCAL_STOP_RECEIPT_INVALID", "Target-local stop receipt invalid");
  }
  const payload = {
    kind: "target_local_stop_receipt",
    schemaVersion: "1",
    stopId: input.stopId,
    environment: input.environment,
    authorizationEpoch: input.authorizationEpoch,
    actorKind: input.actorKind,
    actorIdentity: input.actorIdentity,
    actorFingerprintSha256: input.actorFingerprintSha256,
    reasonSha256: input.reasonSha256,
    committedAt: input.committedAt.toISOString(),
    receiptNonce: input.receiptNonce,
    keyId: input.keyId,
  };
  const canonical = canonicalJson(payload);
  return {
    payload,
    payloadSha256: createHash("sha256").update(canonical).digest("hex"),
    signature: sign(null, Buffer.from(canonical), input.privateKey).toString("base64"),
  };
}

export function signRestrictedCicdStopReceipt(input: {
  stopId: string;
  environment: TargetJournalEnvironment;
  generation: number;
  phase: "stop_committed" | "clear_acknowledged";
  activationId: string | null;
  expectedCurrentReleaseVersionId: string | null;
  requestedAt: Date;
  receiptNonce: string;
  keyId: string;
  actorKind: "target" | "break_glass";
  actorFingerprintSha256: string;
  privateKey: KeyObject;
}) {
  if (!IDENTIFIER.test(input.stopId) || !Number.isSafeInteger(input.generation) || input.generation < 1
    || (input.phase !== "stop_committed" && input.phase !== "clear_acknowledged")
    || (input.activationId !== null && !IDENTIFIER.test(input.activationId))
    || (input.phase === "stop_committed" ? input.activationId !== null : input.activationId === null)
    || (input.expectedCurrentReleaseVersionId !== null
      && !IDENTIFIER.test(input.expectedCurrentReleaseVersionId))
    || !Number.isFinite(input.requestedAt.getTime()) || !IDENTIFIER.test(input.receiptNonce)
    || !IDENTIFIER.test(input.keyId) || !SHA256.test(input.actorFingerprintSha256)
    || (input.actorKind !== "target" && input.actorKind !== "break_glass")
    || input.privateKey.asymmetricKeyType !== "ed25519") {
    return fail("TARGET_STOP_RECEIPT_INVALID", "Target stop receipt invalid");
  }
  const payload = {
    kind: "target_stop_receipt",
    schemaVersion: "1",
    stopId: input.stopId,
    environment: input.environment,
    generation: input.generation,
    phase: input.phase,
    activationId: input.activationId,
    expectedCurrentReleaseVersionId: input.expectedCurrentReleaseVersionId,
    requestedAt: input.requestedAt.toISOString(),
    receiptNonce: input.receiptNonce,
    keyId: input.keyId,
    actorKind: input.actorKind,
    actorFingerprintSha256: input.actorFingerprintSha256,
  };
  const canonical = canonicalJson(payload);
  return {
    payload,
    payloadSha256: createHash("sha256").update(canonical).digest("hex"),
    signature: sign(null, Buffer.from(canonical), input.privateKey).toString("base64"),
  };
}
