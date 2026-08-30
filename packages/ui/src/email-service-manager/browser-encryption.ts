import type { EmailSecretEnvelope } from "@/packages/notifications/src/email-service-management";

function bytesToBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemBytes(value: string) {
  const body = value
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("EMAIL_SECRET_PUBLIC_KEY_INVALID");
  const binary = atob(body);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function encryptEmailSecretPayload(input: {
  keyId: string;
  publicKeyPem: string;
  resendApiKey: string;
  resendWebhookSecret: string;
}): Promise<EmailSecretEnvelope> {
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(input.keyId)) throw new Error("EMAIL_SECRET_KEY_ID_INVALID");
  if (!/^re_[A-Za-z0-9_-]{8,}$/.test(input.resendApiKey)) throw new Error("EMAIL_SECRET_API_KEY_INVALID");
  if (!/^whsec_[A-Za-z0-9_-]{8,}$/.test(input.resendWebhookSecret)) throw new Error("EMAIL_SECRET_WEBHOOK_SECRET_INVALID");
  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemBytes(input.publicKeyPem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", dataKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({
    version: "v1",
    resendApiKey: input.resendApiKey,
    resendWebhookSecret: input.resendWebhookSecret,
  }));
  const [ciphertext, wrappedKey] = await Promise.all([
    crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, payload),
    crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey),
  ]);
  rawKey.fill(0);
  return {
    version: "v1",
    keyId: input.keyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}
