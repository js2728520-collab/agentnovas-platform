import type { Pool } from "pg";

import { sha256 } from "./auth.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base32ToBytes(value: string) {
  const normalized = value.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  if (!normalized || [...normalized].some((character) => !BASE32.includes(character))) {
    throw new Error("TOTP secret 格式无效");
  }
  let bits = 0;
  let bitCount = 0;
  const output: number[] = [];
  for (const character of normalized) {
    bits = (bits << 5) | BASE32.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      output.push((bits >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }
  return new Uint8Array(output);
}

function bytesToBase32(bytes: Uint8Array) {
  let bits = 0;
  let bitCount = 0;
  let output = "";
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      output += BASE32[(bits >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount) output += BASE32[(bits << (5 - bitCount)) & 31];
  return output;
}

async function encryptionKey(environment: Record<string, string | undefined>) {
  const secret = environment.MFA_TOTP_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) throw new Error("MFA TOTP 加密密钥尚未安全配置");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptTotpSecret(
  secret: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(environment),
    encoder.encode(secret),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptTotpSecret(
  encrypted: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const [version, iv, payload] = encrypted.split(".");
  if (version !== "v1" || !iv || !payload) throw new Error("MFA TOTP 凭证格式无效");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    await encryptionKey(environment),
    base64ToBytes(payload),
  );
  return decoder.decode(plain);
}

export async function totpCode(secret: string, counter: number, digits = 6) {
  if (!Number.isSafeInteger(counter) || counter < 0 || !Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("TOTP 参数无效");
  }
  const movingFactor = new Uint8Array(8);
  const factorView = new DataView(movingFactor.buffer);
  factorView.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  factorView.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    "raw", base32ToBytes(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, movingFactor));
  const offset = digest[digest.length - 1] & 0xf;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function sameCode(left: string, right: string) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

async function matchingTotpCounter(secret: string, code: string, now: Date) {
  if (!/^\d{6}$/.test(code)) return null;
  const currentCounter = Math.floor(now.getTime() / 1000 / 30);
  for (const counter of [currentCounter - 1, currentCounter, currentCounter + 1]) {
    if (counter >= 0 && sameCode(await totpCode(secret, counter), code)) return counter;
  }
  return null;
}

export function generateTotpSecret() {
  return bytesToBase32(crypto.getRandomValues(new Uint8Array(20)));
}

export function generateRecoveryCodes(count = 8) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error("恢复码数量无效");
  return Array.from({ length: count }, () => {
    const encoded = bytesToBase32(crypto.getRandomValues(new Uint8Array(10)));
    return `${encoded.slice(0, 5)}-${encoded.slice(5, 10)}-${encoded.slice(10)}`;
  });
}

export async function hashRecoveryCode(code: string) {
  const normalized = code.toUpperCase().replace(/[^A-Z2-7]/g, "");
  return sha256(`mfa-recovery:v1:${normalized}`);
}

export async function startMfaEnrollment(pool: Pool, input: {
  userId: string;
  environment?: Record<string, string | undefined>;
  now?: Date;
}) {
  const secret = generateTotpSecret();
  const encryptedSecret = await encryptTotpSecret(secret, input.environment ?? process.env);
  const now = input.now ?? new Date();
  const result = await pool.query(`
    INSERT INTO user_mfa_totp_credentials (
      user_id, encrypted_secret, encryption_key_version, status, created_at, updated_at
    ) VALUES ($1, $2, 1, 'pending', $3, $3)
    ON CONFLICT (user_id) DO UPDATE SET
      encrypted_secret = EXCLUDED.encrypted_secret,
      encryption_key_version = EXCLUDED.encryption_key_version,
      status = 'pending',
      last_accepted_counter = NULL,
      enabled_at = NULL,
      disabled_at = NULL,
      updated_at = EXCLUDED.updated_at
    WHERE user_mfa_totp_credentials.status <> 'active'
    RETURNING user_id
  `, [input.userId, encryptedSecret, now]);
  return result.rowCount === 1 ? { ok: true as const, secret } : { ok: false as const, code: "ALREADY_ENROLLED" as const };
}

export async function confirmMfaEnrollment(pool: Pool, input: {
  userId: string;
  sessionId: string;
  audience: "operations" | "maintenance";
  code: string;
  idleExpiresAt: string;
  environment?: Record<string, string | undefined>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const credential = (await client.query<{ encrypted_secret: string }>(`
      SELECT encrypted_secret FROM user_mfa_totp_credentials
      WHERE user_id = $1 AND status = 'pending'
      FOR UPDATE
    `, [input.userId])).rows[0];
    if (!credential) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "NOT_PENDING" as const };
    }
    const secret = await decryptTotpSecret(credential.encrypted_secret, input.environment ?? process.env);
    const counter = await matchingTotpCounter(secret, input.code.trim(), now);
    if (counter === null) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "INVALID_CODE" as const };
    }
    const recoveryCodes = generateRecoveryCodes();
    const recoveryHashes = await Promise.all(recoveryCodes.map((code) => hashRecoveryCode(code)));
    await client.query(`
      UPDATE user_mfa_totp_credentials
      SET status = 'active', last_accepted_counter = $2, enabled_at = $3, updated_at = $3
      WHERE user_id = $1 AND status = 'pending'
    `, [input.userId, counter, now]);
    await client.query("DELETE FROM user_mfa_recovery_codes WHERE user_id = $1", [input.userId]);
    for (const recoveryHash of recoveryHashes) {
      await client.query(`
        INSERT INTO user_mfa_recovery_codes (id, user_id, code_hash, created_at)
        VALUES ($1, $2, $3, $4)
      `, [crypto.randomUUID(), input.userId, recoveryHash, now]);
    }
    const session = await client.query(`
      UPDATE sessions
      SET mfa_level = 'totp', mfa_verified_at = $4, last_seen_at = $4,
          idle_expires_at = $5
      WHERE id = $1 AND user_id = $2 AND app_audience = $3
        AND mfa_level = 'primary' AND revoked_at IS NULL
      RETURNING id
    `, [input.sessionId, input.userId, input.audience, now, input.idleExpiresAt]);
    if (session.rowCount !== 1) throw new Error("PRIMARY_SESSION_STATE_CHANGED");
    await client.query(`
      INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json, created_at)
      VALUES ($1, $2, 'auth.mfa_enrolled', 'session', $3, $4, $5)
    `, [crypto.randomUUID(), input.userId, input.sessionId, JSON.stringify({ appAudience: input.audience, recoveryCodesIssued: recoveryCodes.length }), now]);
    await client.query("COMMIT");
    return { ok: true as const, recoveryCodes };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyAndConsumeMfa(pool: Pool, input: {
  userId: string;
  code: string;
  now?: Date;
  environment?: Record<string, string | undefined>;
}) {
  const now = input.now ?? new Date();
  const code = input.code.trim().toUpperCase();
  if (/^\d{6}$/.test(code)) {
    const credential = (await pool.query<{ encrypted_secret: string; last_accepted_counter: string | null }>(`
      SELECT encrypted_secret, last_accepted_counter
      FROM user_mfa_totp_credentials
      WHERE user_id = $1 AND status = 'active'
    `, [input.userId])).rows[0];
    if (!credential) return { ok: false as const, code: "NOT_ENROLLED" as const };
    const secret = await decryptTotpSecret(credential.encrypted_secret, input.environment ?? process.env);
    const acceptedCounter = await matchingTotpCounter(secret, code, now);
    if (acceptedCounter === null) return { ok: false as const, code: "INVALID_OR_REPLAYED" as const };
    const updated = await pool.query(`
      UPDATE user_mfa_totp_credentials
      SET last_accepted_counter = $2, updated_at = $3
      WHERE user_id = $1
        AND status = 'active'
        AND (last_accepted_counter IS NULL OR last_accepted_counter < $2)
      RETURNING user_id
    `, [input.userId, acceptedCounter, now]);
    return updated.rowCount === 1
      ? { ok: true as const, level: "totp" as const }
      : { ok: false as const, code: "INVALID_OR_REPLAYED" as const };
  }

  const recoveryHash = await hashRecoveryCode(code);
  const consumed = await pool.query(`
    UPDATE user_mfa_recovery_codes
    SET used_at = $3
    WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
    RETURNING id
  `, [input.userId, recoveryHash, now]);
  return consumed.rowCount === 1
    ? { ok: true as const, level: "recovery" as const }
    : { ok: false as const, code: "INVALID_OR_REPLAYED" as const };
}
