const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function base64ToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("通知令牌密文格式无效");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function encryptionKey(environment: Record<string, string | undefined>) {
  const secret = environment.NOTIFICATION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) throw new Error("通知令牌加密密钥尚未安全配置");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptNotificationToken(
  token: string,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!token || token.length > 2_048) throw new Error("通知令牌无效");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(environment),
    encoder.encode(token),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptNotificationToken(
  encrypted: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const [version, iv, payload, extra] = encrypted.split(".");
  if (version !== "v1" || !iv || !payload || extra) throw new Error("通知令牌密文格式无效");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    await encryptionKey(environment),
    base64ToBytes(payload),
  );
  const token = decoder.decode(plain);
  if (!token || token.length > 2_048) throw new Error("通知令牌无效");
  return token;
}
