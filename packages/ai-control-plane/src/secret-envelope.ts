export type SecretEnvelopeCommand = {
  commandId: string;
  targetConnectionRevisionId: string;
  brokerKeyId: string;
  algorithm: "AES-256-GCM+RSA-OAEP-SHA256";
  wrappedDataKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  envelopeDigestSha256: string;
};

const encoder = new TextEncoder();

function assertIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${label} is invalid`);
}

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function canonicalEnvelope(value: Omit<SecretEnvelopeCommand, "envelopeDigestSha256">) {
  return JSON.stringify([
    value.commandId,
    value.targetConnectionRevisionId,
    value.brokerKeyId,
    value.algorithm,
    value.wrappedDataKey,
    value.iv,
    value.ciphertext,
    value.authTag,
  ]);
}

export function secretEnvelopeAdditionalData(input: {
  commandId: string;
  targetConnectionRevisionId: string;
  brokerKeyId: string;
}) {
  return encoder.encode(`${input.commandId}\n${input.targetConnectionRevisionId}\n${input.brokerKeyId}`);
}

export async function secretEnvelopeDigest(value: Omit<SecretEnvelopeCommand, "envelopeDigestSha256">) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalEnvelope(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createSecretEnvelope(input: {
  commandId: string;
  targetConnectionRevisionId: string;
  brokerKeyId: string;
  publicKeySpkiBase64: string;
  secret: string;
}): Promise<SecretEnvelopeCommand> {
  assertIdentifier(input.commandId, "commandId");
  assertIdentifier(input.targetConnectionRevisionId, "targetConnectionRevisionId");
  assertIdentifier(input.brokerKeyId, "brokerKeyId");
  const secretBytes = encoder.encode(input.secret);
  if (secretBytes.length < 1 || secretBytes.length > 4_096 || secretBytes.includes(0)) {
    secretBytes.fill(0);
    throw new Error("secret length is invalid");
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      base64ToBytes(input.publicKeySpkiBase64),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const rawDataKey = new Uint8Array(await crypto.subtle.exportKey("raw", dataKey));
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv,
        additionalData: secretEnvelopeAdditionalData(input),
        tagLength: 128,
      }, dataKey, secretBytes));
      const wrappedDataKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawDataKey));
      const withoutDigest = {
        commandId: input.commandId,
        targetConnectionRevisionId: input.targetConnectionRevisionId,
        brokerKeyId: input.brokerKeyId,
        algorithm: "AES-256-GCM+RSA-OAEP-SHA256" as const,
        wrappedDataKey: bytesToBase64(wrappedDataKey),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(encrypted.subarray(0, -16)),
        authTag: bytesToBase64(encrypted.subarray(-16)),
      };
      return { ...withoutDigest, envelopeDigestSha256: await secretEnvelopeDigest(withoutDigest) };
    } finally {
      rawDataKey.fill(0);
    }
  } finally {
    secretBytes.fill(0);
  }
}
