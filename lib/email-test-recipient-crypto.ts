import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RECIPIENT_CONTEXT = "agentnovas:email-test-recipient:v1";
const VERIFICATION_CONTEXT = "agentnovas:email-test-verification:v1";

type Environment = Record<string, string | undefined>;

function secret(environment: Environment) {
  const value = environment.EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) throw new Error("EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY_UNAVAILABLE");
  return value;
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("EMAIL_TEST_RECIPIENT_CIPHERTEXT_INVALID");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function recipientKey(environment: Environment) {
  const material = createHash("sha256").update(`${RECIPIENT_CONTEXT}\0${secret(environment)}`).digest();
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function verificationKey(environment: Environment) {
  const material = createHash("sha256").update(`${VERIFICATION_CONTEXT}\0${secret(environment)}`).digest();
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptValue(value: string, key: CryptoKey, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: encoder.encode(context),
  }, key, encoder.encode(value));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

async function decryptValue(value: string, key: CryptoKey, context: string) {
  const [version, iv, payload, extra] = value.split(".");
  if (version !== "v1" || !iv || !payload || extra) throw new Error("EMAIL_TEST_RECIPIENT_CIPHERTEXT_INVALID");
  const decrypted = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: decodeBase64Url(iv),
    additionalData: encoder.encode(context),
  }, key, decodeBase64Url(payload));
  return decoder.decode(decrypted);
}

export async function encryptEmailTestRecipient(value: string, environment: Environment = process.env) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254) throw new Error("EMAIL_TEST_RECIPIENT_INVALID");
  return encryptValue(normalized, await recipientKey(environment), RECIPIENT_CONTEXT);
}

export async function decryptEmailTestRecipient(value: string, environment: Environment = process.env) {
  const recipient = await decryptValue(value, await recipientKey(environment), RECIPIENT_CONTEXT);
  if (!recipient || recipient.length > 254) throw new Error("EMAIL_TEST_RECIPIENT_INVALID");
  return recipient;
}

export async function encryptEmailVerificationCode(code: string, environment: Environment = process.env) {
  if (!/^\d{6}$/.test(code)) throw new Error("EMAIL_RECIPIENT_CODE_INVALID");
  return encryptValue(code, await verificationKey(environment), VERIFICATION_CONTEXT);
}

export async function decryptEmailVerificationCode(value: string, environment: Environment = process.env) {
  const code = await decryptValue(value, await verificationKey(environment), VERIFICATION_CONTEXT);
  if (!/^\d{6}$/.test(code)) throw new Error("EMAIL_RECIPIENT_CODE_INVALID");
  return code;
}

export function hashEmailVerificationCode(
  recipientId: string,
  code: string,
  environment: Environment = process.env,
) {
  if (!recipientId || !/^\d{6}$/.test(code)) throw new Error("EMAIL_RECIPIENT_CODE_INVALID");
  return createHmac("sha256", secret(environment))
    .update(`${VERIFICATION_CONTEXT}\0${recipientId}\0${code}`)
    .digest("hex");
}

export function emailVerificationCodeMatches(
  recipientId: string,
  code: string,
  expectedHash: string,
  environment: Environment = process.env,
) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^\d{6}$/.test(code)) return false;
  const actual = Buffer.from(hashEmailVerificationCode(recipientId, code, environment), "hex");
  return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}
