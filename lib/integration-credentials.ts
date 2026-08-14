const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string) {
  const raw = atob(value);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const secret = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY || process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error("API 凭证加密密钥尚未配置");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptIntegrationSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptIntegrationSecret(value: string) {
  const [version, iv, data] = value.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("无法识别 API 凭证格式");
  const key = await encryptionKey();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(data));
  return decoder.decode(plain);
}

export function maskedIntegrationSecret(value: string) {
  return value.length < 8 ? "••••••••" : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
