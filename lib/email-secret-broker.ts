import { createHash, createPrivateKey } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { EmailSecretEnvelope } from "../packages/notifications/src/email-service-management.ts";

type Environment = Record<string, string | undefined>;
type SecretKind = "notification" | "maintenance";

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("EMAIL_SECRET_ENVELOPE_INVALID");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function exactPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EMAIL_SECRET_PAYLOAD_INVALID");
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).sort().join(",") !== "resendApiKey,resendWebhookSecret,version" || payload.version !== "v1") {
    throw new Error("EMAIL_SECRET_PAYLOAD_INVALID");
  }
  if (typeof payload.resendApiKey !== "string" || !/^re_[A-Za-z0-9_-]{8,}$/.test(payload.resendApiKey)) {
    throw new Error("EMAIL_SECRET_API_KEY_INVALID");
  }
  if (typeof payload.resendWebhookSecret !== "string" || !/^whsec_[A-Za-z0-9_-]{8,}$/.test(payload.resendWebhookSecret)) {
    throw new Error("EMAIL_SECRET_WEBHOOK_SECRET_INVALID");
  }
  return {
    resendApiKey: payload.resendApiKey,
    resendWebhookSecret: payload.resendWebhookSecret,
  };
}

export async function decryptEmailSecretEnvelope(
  envelope: EmailSecretEnvelope,
  input: { keyId: string; privateKeyPem: string },
) {
  if (envelope.version !== "v1") throw new Error("EMAIL_SECRET_ENVELOPE_VERSION_INVALID");
  if (envelope.keyId !== input.keyId) throw new Error("EMAIL_SECRET_KEY_ID_MISMATCH");
  const privateDer = createPrivateKey(input.privateKeyPem).export({ type: "pkcs8", format: "der" });
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateDer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const rawKey = new Uint8Array(await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    decodeBase64Url(envelope.wrappedKey),
  ));
  try {
    const dataKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: decodeBase64Url(envelope.iv),
    }, dataKey, decodeBase64Url(envelope.ciphertext));
    if (plain.byteLength > 8_192) throw new Error("EMAIL_SECRET_PAYLOAD_INVALID");
    return exactPayload(JSON.parse(new TextDecoder().decode(plain)) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("EMAIL_SECRET_")) throw error;
    throw new Error("EMAIL_SECRET_DECRYPTION_FAILED");
  } finally {
    rawKey.fill(0);
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function durableWrite(path: string, content: string) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function applyEmailSecretConfigurationToDirectory(input: {
  directory: string;
  requestId: string;
  resendApiKey: string;
  resendWebhookSecret: string;
  now?: Date;
}) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestId)) throw new Error("EMAIL_SECRET_REQUEST_ID_INVALID");
  const secrets = exactPayload({
    version: "v1",
    resendApiKey: input.resendApiKey,
    resendWebhookSecret: input.resendWebhookSecret,
  });
  const now = input.now ?? new Date();
  const version = `email-${now.toISOString().replace(/[-:.]/g, "")}-${sha256(input.requestId).slice(0,12)}`;
  const directory = input.directory;
  await mkdir(join(directory, "versions"), { recursive: true, mode: 0o700 });
  const notificationFile = `versions/${version}.notification.env`;
  const maintenanceFile = `versions/${version}.maintenance.env`;
  const notificationContent = `EMAIL_SECRET_CONFIGURATION_VERSION=${version}\nRESEND_API_KEY=${secrets.resendApiKey}\n`;
  const maintenanceContent = `EMAIL_SECRET_CONFIGURATION_VERSION=${version}\nRESEND_WEBHOOK_SECRET=${secrets.resendWebhookSecret}\n`;
  const notificationPath = join(directory, notificationFile);
  const maintenancePath = join(directory, maintenanceFile);
  const manifestTemporaryPath = join(directory, `.manifest-${version}.tmp`);
  try {
    await durableWrite(notificationPath, notificationContent);
    await durableWrite(maintenancePath, maintenanceContent);
    const manifest = {
      schemaVersion: "1",
      version,
      appliedAt: now.toISOString(),
      notification: { file: notificationFile, sha256: sha256(notificationContent) },
      maintenance: { file: maintenanceFile, sha256: sha256(maintenanceContent) },
    };
    await durableWrite(manifestTemporaryPath, `${JSON.stringify(manifest)}\n`);
    await rename(manifestTemporaryPath, join(directory, "manifest.json"));
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return {
      version,
      fingerprint: sha256(`${secrets.resendApiKey}\0${secrets.resendWebhookSecret}`).slice(0,16),
    };
  } catch (error) {
    await unlink(manifestTemporaryPath).catch(() => undefined);
    throw error;
  }
}

type ManifestEntry = { file: string; sha256: string };
type Manifest = {
  schemaVersion: "1";
  version: string;
  notification: ManifestEntry;
  maintenance: ManifestEntry;
};

function manifestValue(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EMAIL_SECRET_MANIFEST_INVALID");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== "1" || typeof manifest.version !== "string" || !/^email-[A-Za-z0-9-]{20,100}$/.test(manifest.version)) {
    throw new Error("EMAIL_SECRET_MANIFEST_INVALID");
  }
  for (const kind of ["notification","maintenance"] as const) {
    const entry = manifest[kind];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("EMAIL_SECRET_MANIFEST_INVALID");
    const fields = entry as Record<string, unknown>;
    if (typeof fields.file !== "string" || basename(fields.file) !== fields.file.split("/").at(-1)
      || !fields.file.startsWith(`versions/${manifest.version}.`)
      || typeof fields.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.sha256)) {
      throw new Error("EMAIL_SECRET_MANIFEST_INVALID");
    }
  }
  return manifest as unknown as Manifest;
}

export async function readManagedEmailSecret(kind: SecretKind, environment: Environment = process.env) {
  const directory = environment.EMAIL_SECRET_DIRECTORY?.trim();
  if (!directory) throw new Error("EMAIL_SECRET_DIRECTORY_UNAVAILABLE");
  const manifest = manifestValue(JSON.parse(await readFile(join(directory,"manifest.json"),"utf8")) as unknown);
  const expectedVersion = environment.EMAIL_SECRET_CONFIGURATION_VERSION?.trim();
  if (expectedVersion && expectedVersion !== manifest.version) throw new Error("EMAIL_SECRET_VERSION_MISMATCH");
  const entry = manifest[kind];
  const content = await readFile(join(directory,entry.file),"utf8");
  if (sha256(content) !== entry.sha256) throw new Error("EMAIL_SECRET_CHECKSUM_MISMATCH");
  const key = kind === "notification" ? "RESEND_API_KEY" : "RESEND_WEBHOOK_SECRET";
  const lines = content.trimEnd().split("\n");
  if (lines.length !== 2 || lines[0] !== `EMAIL_SECRET_CONFIGURATION_VERSION=${manifest.version}` || !lines[1].startsWith(`${key}=`)) {
    throw new Error("EMAIL_SECRET_FILE_INVALID");
  }
  const value = lines[1].slice(key.length + 1);
  if (kind === "notification" ? !/^re_[A-Za-z0-9_-]{8,}$/.test(value) : !/^whsec_[A-Za-z0-9_-]{8,}$/.test(value)) {
    throw new Error("EMAIL_SECRET_FILE_INVALID");
  }
  return value;
}

export async function resolveEmailSecret(kind: SecretKind, environment: Environment = process.env) {
  if (environment.EMAIL_SECRET_DIRECTORY?.trim()) {
    try {
      return await readManagedEmailSecret(kind,environment);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      // An empty managed directory is expected during the one-time migration.
      // Once a manifest exists, malformed content, checksum failures and access
      // errors must fail closed instead of silently reviving a stale env value.
    }
  }
  return kind === "notification"
    ? environment.RESEND_API_KEY?.trim() ?? ""
    : environment.RESEND_WEBHOOK_SECRET?.trim() ?? "";
}
