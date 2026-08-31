import { createHash, createPrivateKey } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { PaymentSecretEnvelope } from "../packages/payments/src/udun-service-management.ts";
import { normalizeUdunCallbackUrl, normalizeUdunGatewayBaseUrl, readUdunRuntimeConfig, type UdunRuntimeConfig } from "./udun-payment.ts";

type Environment = Record<string, string | undefined>;
type ConsumerKind = "client" | "maintenance";
type PaymentConfiguration = UdunRuntimeConfig & {
  provider: "udun";
  managedConfigurationVersion: string | null;
};

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("PAYMENT_SECRET_ENVELOPE_INVALID");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function exactPayload(value: unknown, allowedCallbackHosts: readonly string[]): PaymentConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAYMENT_SECRET_PAYLOAD_INVALID");
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).sort().join(",") !== "addressRequestCoinField,apiKey,callbackUrl,gatewayBaseUrl,merchantId,provider,version"
    || payload.version !== "v1" || payload.provider !== "udun") throw new Error("PAYMENT_SECRET_PAYLOAD_INVALID");
  const merchantId = typeof payload.merchantId === "string" ? payload.merchantId : "";
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
  const addressRequestCoinField = payload.addressRequestCoinField;
  if (!/^\d{1,32}$/.test(merchantId)) throw new Error("PAYMENT_SECRET_MERCHANT_INVALID");
  if (apiKey.length < 8 || apiKey.length > 256 || /\s/.test(apiKey)) throw new Error("PAYMENT_SECRET_API_KEY_INVALID");
  if (addressRequestCoinField !== "mainCoinType" && addressRequestCoinField !== "coinType") {
    throw new Error("PAYMENT_SECRET_PROTOCOL_INVALID");
  }
  return {
    provider: "udun",
    managedConfigurationVersion: null,
    gatewayBaseUrl: normalizeUdunGatewayBaseUrl(String(payload.gatewayBaseUrl ?? "")),
    merchantId,
    apiKey,
    callbackUrl: normalizeUdunCallbackUrl(String(payload.callbackUrl ?? ""), allowedCallbackHosts),
    addressRequestCoinField,
  };
}

export async function decryptPaymentSecretEnvelope(envelope: PaymentSecretEnvelope, input: {
  keyId: string;
  privateKeyPem: string;
  allowedCallbackHosts: readonly string[];
}) {
  if (envelope.version !== "v1") throw new Error("PAYMENT_SECRET_ENVELOPE_VERSION_INVALID");
  if (envelope.keyId !== input.keyId) throw new Error("PAYMENT_SECRET_KEY_ID_MISMATCH");
  const privateDer = createPrivateKey(input.privateKeyPem).export({ type: "pkcs8", format: "der" });
  const privateKey = await crypto.subtle.importKey("pkcs8", privateDer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, decodeBase64Url(envelope.wrappedKey)));
  try {
    const dataKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(envelope.iv) }, dataKey, decodeBase64Url(envelope.ciphertext));
    if (plain.byteLength > 12_288) throw new Error("PAYMENT_SECRET_PAYLOAD_INVALID");
    return exactPayload(JSON.parse(new TextDecoder().decode(plain)) as unknown, input.allowedCallbackHosts);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PAYMENT_SECRET_")) throw error;
    throw new Error("PAYMENT_SECRET_DECRYPTION_FAILED");
  } finally { rawKey.fill(0); }
}

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

async function durableWrite(path: string, content: string) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(content, { encoding: "utf8" }); await handle.sync(); }
  finally { await handle.close(); }
}

function configurationContent(version: string, config: PaymentConfiguration) {
  return [
    `PAYMENT_SECRET_CONFIGURATION_VERSION=${version}`,
    `UDUN_GATEWAY_BASE_URL=${config.gatewayBaseUrl}`,
    `UDUN_MERCHANT_ID=${config.merchantId}`,
    `UDUN_API_KEY=${config.apiKey}`,
    `UDUN_CALLBACK_URL=${config.callbackUrl}`,
    `UDUN_ADDRESS_REQUEST_COIN_FIELD=${config.addressRequestCoinField}`,
    "",
  ].join("\n");
}

export async function applyPaymentSecretConfigurationToDirectory(input: {
  directory: string;
  requestId: string;
  configuration: PaymentConfiguration;
  now?: Date;
}) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestId)) throw new Error("PAYMENT_SECRET_REQUEST_ID_INVALID");
  const config = exactPayload({ version: "v1", ...input.configuration }, [new URL(input.configuration.callbackUrl).hostname]);
  const now = input.now ?? new Date();
  const version = `payment-${now.toISOString().replace(/[-:.]/g, "")}-${sha256(input.requestId).slice(0, 12)}`;
  await mkdir(join(input.directory, "versions"), { recursive: true, mode: 0o700 });
  const clientFile = `versions/${version}.client.env`;
  const maintenanceFile = `versions/${version}.maintenance.env`;
  const content = configurationContent(version, config);
  const clientPath = join(input.directory, clientFile);
  const maintenancePath = join(input.directory, maintenanceFile);
  const temporaryManifest = join(input.directory, `.manifest-${version}.tmp`);
  try {
    await durableWrite(clientPath, content);
    await durableWrite(maintenancePath, content);
    const manifest = {
      schemaVersion: "1", version, appliedAt: now.toISOString(),
      client: { file: clientFile, sha256: sha256(content) },
      maintenance: { file: maintenanceFile, sha256: sha256(content) },
    };
    await durableWrite(temporaryManifest, `${JSON.stringify(manifest)}\n`);
    await rename(temporaryManifest, join(input.directory, "manifest.json"));
    const directoryHandle = await open(input.directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return {
      version,
      fingerprint: sha256(`${config.gatewayBaseUrl}\0${config.merchantId}\0${config.apiKey}\0${config.callbackUrl}\0${config.addressRequestCoinField}`).slice(0, 16),
    };
  } catch (error) {
    await unlink(temporaryManifest).catch(() => undefined);
    throw error;
  }
}

type ManifestEntry = { file: string; sha256: string };
type Manifest = { schemaVersion: "1"; version: string; client: ManifestEntry; maintenance: ManifestEntry };

function manifestValue(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAYMENT_SECRET_MANIFEST_INVALID");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== "1" || typeof manifest.version !== "string" || !/^payment-[A-Za-z0-9-]{20,110}$/.test(manifest.version)) {
    throw new Error("PAYMENT_SECRET_MANIFEST_INVALID");
  }
  for (const kind of ["client", "maintenance"] as const) {
    const entry = manifest[kind];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("PAYMENT_SECRET_MANIFEST_INVALID");
    const fields = entry as Record<string, unknown>;
    const expectedFile = `versions/${manifest.version}.${kind}.env`;
    if (fields.file !== expectedFile || typeof fields.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.sha256)) {
      throw new Error("PAYMENT_SECRET_MANIFEST_INVALID");
    }
  }
  return manifest as unknown as Manifest;
}

function parseConfigurationFile(content: string, version: string): PaymentConfiguration {
  const lines = content.trimEnd().split("\n");
  if (lines.length !== 6 || lines[0] !== `PAYMENT_SECRET_CONFIGURATION_VERSION=${version}`) {
    throw new Error("PAYMENT_SECRET_FILE_INVALID");
  }
  const values: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("PAYMENT_SECRET_FILE_INVALID");
    const key = line.slice(0, separator);
    if (Object.hasOwn(values, key)) throw new Error("PAYMENT_SECRET_FILE_INVALID");
    values[key] = line.slice(separator + 1);
  }
  const runtime = readUdunRuntimeConfig(values as NodeJS.ProcessEnv);
  return { provider: "udun", managedConfigurationVersion: version, ...runtime };
}

export async function readManagedUdunRuntimeConfig(kind: ConsumerKind, environment: Environment = process.env) {
  const directory = environment.PAYMENT_SECRET_DIRECTORY?.trim();
  if (!directory) throw new Error("PAYMENT_SECRET_DIRECTORY_UNAVAILABLE");
  const manifest = manifestValue(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown);
  const expectedVersion = environment.PAYMENT_SECRET_CONFIGURATION_VERSION?.trim();
  if (expectedVersion && expectedVersion !== manifest.version) throw new Error("PAYMENT_SECRET_VERSION_MISMATCH");
  const entry = manifest[kind];
  const content = await readFile(join(directory, entry.file), "utf8");
  if (sha256(content) !== entry.sha256) throw new Error("PAYMENT_SECRET_CHECKSUM_MISMATCH");
  return parseConfigurationFile(content, manifest.version);
}

export async function resolveUdunRuntimeConfig(kind: ConsumerKind, environment: Environment = process.env): Promise<PaymentConfiguration> {
  if (environment.PAYMENT_SECRET_DIRECTORY?.trim()) {
    try { return await readManagedUdunRuntimeConfig(kind, environment); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return {
    provider: "udun",
    managedConfigurationVersion: null,
    ...readUdunRuntimeConfig(environment as NodeJS.ProcessEnv),
  };
}
