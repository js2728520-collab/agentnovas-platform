import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  secretEnvelopeAdditionalData,
  secretEnvelopeDigest,
  type SecretEnvelopeCommand,
} from "@agentnovas/ai-control-plane";

export type SecretBrokerReceipt = {
  commandId: string;
  targetConnectionRevisionId: string;
  brokerKeyId: string;
  envelopeDigestSha256: string;
  secretRef: string;
  secretFingerprint: string;
  fileMode: "0600";
  directoryMode: "0700";
  brokerInstanceId: string;
  completedAt: string;
};

class SecretBrokerError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = "SecretBrokerError";
    this.code = code;
  }
}

function strictBase64(value: string, maximumBytes: number) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SecretBrokerError("AI_SECRET_ENVELOPE_INVALID");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (!bytes.length || bytes.length > maximumBytes) throw new SecretBrokerError("AI_SECRET_ENVELOPE_INVALID");
  return bytes;
}

function privateKeyBytes(pem: string) {
  const encoded = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  return strictBase64(encoded, 16_384);
}

function managedFileName(targetConnectionRevisionId: string) {
  return `${createHash("sha256").update(targetConnectionRevisionId).digest("hex")}.secret`;
}

async function prepareDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) === "/") throw new SecretBrokerError("AI_SECRET_DIRECTORY_INVALID");
  await mkdir(directory, { recursive: true,mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new SecretBrokerError("AI_SECRET_DIRECTORY_INVALID");
  await chmod(directory, 0o700);
}

export async function loadBrokerPrivateKey(path: string) {
  if (!isAbsolute(path)) throw new SecretBrokerError("AI_SECRET_PRIVATE_KEY_FILE_INVALID");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 16_384) {
    throw new SecretBrokerError("AI_SECRET_PRIVATE_KEY_FILE_INVALID");
  }
  const value = await readFile(path,"utf8");
  if (!value.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new SecretBrokerError("AI_SECRET_PRIVATE_KEY_FILE_INVALID");
  }
  return value;
}

export async function processSecretEnvelope(command: SecretEnvelopeCommand, options: {
  brokerPrivateKeyPem: string;
  managedDirectory: string;
  brokerInstanceId: string;
  now?: () => Date;
}): Promise<SecretBrokerReceipt> {
  const withoutDigest = {
    commandId: command.commandId,
    targetConnectionRevisionId: command.targetConnectionRevisionId,
    brokerKeyId: command.brokerKeyId,
    algorithm: command.algorithm,
    wrappedDataKey: command.wrappedDataKey,
    iv: command.iv,
    ciphertext: command.ciphertext,
    authTag: command.authTag,
  };
  if (command.algorithm !== "AES-256-GCM+RSA-OAEP-SHA256"
    || await secretEnvelopeDigest(withoutDigest) !== command.envelopeDigestSha256) {
    throw new SecretBrokerError("AI_SECRET_ENVELOPE_INVALID");
  }

  let rawDataKey: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes(options.brokerPrivateKeyPem),
      { name: "RSA-OAEP",hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    rawDataKey = new Uint8Array(await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      strictBase64(command.wrappedDataKey, 16_384),
    ));
    if (rawDataKey.length !== 32) throw new SecretBrokerError("AI_SECRET_DECRYPT_FAILED");
    const dataKey = await crypto.subtle.importKey(
      "raw",
      rawDataKey.buffer as ArrayBuffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const ciphertext = strictBase64(command.ciphertext, 8_192);
    const authTag = strictBase64(command.authTag, 16);
    if (authTag.length !== 16) throw new SecretBrokerError("AI_SECRET_ENVELOPE_INVALID");
    const encrypted = new Uint8Array(ciphertext.length + authTag.length);
    encrypted.set(ciphertext);
    encrypted.set(authTag,ciphertext.length);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: strictBase64(command.iv, 12),
      additionalData: secretEnvelopeAdditionalData(command),
      tagLength: 128,
    },dataKey,encrypted));
    if (plaintext.length < 1 || plaintext.length > 4_096 || plaintext.includes(0)) {
      throw new SecretBrokerError("AI_SECRET_DECRYPT_FAILED");
    }

    await prepareDirectory(options.managedDirectory);
    const fileName = managedFileName(command.targetConnectionRevisionId);
    const destination = join(options.managedDirectory,fileName);
    const temporary = join(options.managedDirectory,`.${fileName}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary,"wx",0o600);
      await handle.writeFile(plaintext);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary,destination);
      await chmod(destination,0o600);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary,{ force: true }).catch(() => undefined);
      throw error;
    }
    const secretFingerprint = createHash("sha256").update(plaintext).digest("hex");
    return {
      commandId: command.commandId,
      targetConnectionRevisionId: command.targetConnectionRevisionId,
      brokerKeyId: command.brokerKeyId,
      envelopeDigestSha256: command.envelopeDigestSha256,
      secretRef: `managed://ai/${fileName}`,
      secretFingerprint,
      fileMode: "0600",
      directoryMode: "0700",
      brokerInstanceId: options.brokerInstanceId,
      completedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
  } catch (error) {
    if (error instanceof SecretBrokerError) throw error;
    throw new SecretBrokerError("AI_SECRET_DECRYPT_FAILED");
  } finally {
    rawDataKey?.fill(0);
    plaintext?.fill(0);
  }
}
