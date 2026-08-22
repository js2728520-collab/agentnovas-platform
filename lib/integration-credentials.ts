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
  // 这里原本会在 INTEGRATION_CREDENTIAL_ENCRYPTION_KEY 缺失时回退到
  // EXCHANGE_CREDENTIAL_ENCRYPTION_KEY。那个回退让运维端只要漏配一个变量，就必须
  // 持有交易所凭证密钥——而运维端从不需要解密任何客户的交易凭证。回退已删除。
  //
  // 若既有的集成凭证是用交易所密钥加密的，把同一个值显式配成
  // INTEGRATION_CREDENTIAL_ENCRYPTION_KEY 即可继续解密，随后应重新加密以便两把
  // 密钥独立轮换。见 docs/adr/0019。
  const secret = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) throw new Error("API 凭证加密密钥尚未配置");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function llmProfileEncryptionKey() {
  const secret = process.env.LLM_PROFILE_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) throw new Error("LLM Profile 加密密钥尚未配置");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptWithKey(value: string, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptWithKey(value: string, key: CryptoKey) {
  const [version, iv, data] = value.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("无法识别 API 凭证格式");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(data));
  return decoder.decode(plain);
}

export async function encryptIntegrationSecret(value: string) {
  return encryptWithKey(value, await encryptionKey());
}

export async function decryptIntegrationSecret(value: string) {
  return decryptWithKey(value, await encryptionKey());
}

export async function encryptLlmProfileSecret(value: string) {
  return encryptWithKey(value, await llmProfileEncryptionKey());
}

export async function decryptLlmProfileSecret(value: string) {
  return decryptWithKey(value, await llmProfileEncryptionKey());
}

export function maskedIntegrationSecret(value: string) {
  return value.length < 8 ? "••••••••" : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
