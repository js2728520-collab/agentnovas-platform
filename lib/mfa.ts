import type { Pool } from "pg";

import { sha256 } from "./auth.ts";
import type { AppAudience } from "./riverton-apps.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function mfaEnforcementEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return environment.MFA_ENFORCEMENT_ENABLED?.trim().toLowerCase() === "true";
}

export function mfaLoginRequirement(
  audience: AppAudience,
  enrolled: boolean,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!mfaEnforcementEnabled(environment)) {
    return { required: false, enrollmentRequired: false };
  }
  const internal = audience !== "client";
  return {
    required: internal || enrolled,
    enrollmentRequired: internal && !enrolled,
  };
}

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
  sessionTokenHash?: string;
  environment?: Record<string, string | undefined>;
  now?: Date;
}) {
  const secret = generateTotpSecret();
  const encryptedSecret = await encryptTotpSecret(secret, input.environment ?? process.env);
  const now = input.now ?? new Date();
  if (input.sessionTokenHash) {
    const result = await pool.query<{ changed: boolean }>(
      "SELECT client_mfa_start($1,$2,$3) AS changed",
      [input.sessionTokenHash,encryptedSecret,now],
    );
    return result.rows[0]?.changed ? { ok: true as const, secret } : { ok: false as const, code: "ALREADY_ENROLLED" as const };
  }
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
  sessionTokenHash?: string;
  audience: AppAudience;
  code: string;
  idleExpiresAt: string;
  environment?: Record<string, string | undefined>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const credential = (await client.query<{ encrypted_secret: string }>(input.sessionTokenHash ? `
      SELECT encrypted_secret FROM client_mfa_credential($1,'pending')
    ` : `
      SELECT encrypted_secret FROM user_mfa_totp_credentials
      WHERE user_id = $1 AND status = 'pending'
      FOR UPDATE
    `, [input.sessionTokenHash ?? input.userId])).rows[0];
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
    if (input.sessionTokenHash) {
      const codes = recoveryHashes.map((codeHash) => ({ id: crypto.randomUUID(), code_hash: codeHash }));
      const completed = await client.query<{ completed: boolean }>(`
        SELECT client_mfa_complete_enrollment($1,$2,$3,$4::jsonb,$5) AS completed
      `, [input.sessionTokenHash,counter,input.idleExpiresAt,JSON.stringify(codes),now]);
      if (!completed.rows[0]?.completed) throw new Error("PRIMARY_SESSION_STATE_CHANGED");
    } else {
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
    }
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

export async function verifyAndConsumeMfa(pool: Pick<Pool, "query">, input: {
  userId: string;
  sessionTokenHash?: string;
  code: string;
  now?: Date;
  environment?: Record<string, string | undefined>;
}) {
  const now = input.now ?? new Date();
  const code = input.code.trim().toUpperCase();
  if (/^\d{6}$/.test(code)) {
    const credential = (await pool.query<{ encrypted_secret: string; last_accepted_counter: string | null }>(input.sessionTokenHash ? `
      SELECT encrypted_secret,last_accepted_counter FROM client_mfa_credential($1,'active')
    ` : `
      SELECT encrypted_secret, last_accepted_counter
      FROM user_mfa_totp_credentials
      WHERE user_id = $1 AND status = 'active'
    `, [input.sessionTokenHash ?? input.userId])).rows[0];
    if (!credential) return { ok: false as const, code: "NOT_ENROLLED" as const };
    const secret = await decryptTotpSecret(credential.encrypted_secret, input.environment ?? process.env);
    const acceptedCounter = await matchingTotpCounter(secret, code, now);
    if (acceptedCounter === null) return { ok: false as const, code: "INVALID_OR_REPLAYED" as const };
    const updated = input.sessionTokenHash
      ? await pool.query<{ changed: boolean }>("SELECT client_mfa_accept_totp($1,$2,$3) AS changed", [input.sessionTokenHash,acceptedCounter,now])
      : await pool.query(`
      UPDATE user_mfa_totp_credentials
      SET last_accepted_counter = $2, updated_at = $3
      WHERE user_id = $1
        AND status = 'active'
        AND (last_accepted_counter IS NULL OR last_accepted_counter < $2)
      RETURNING user_id
    `, [input.userId, acceptedCounter, now]);
    return (input.sessionTokenHash ? updated.rows[0]?.changed : updated.rowCount === 1)
      ? { ok: true as const, level: "totp" as const }
      : { ok: false as const, code: "INVALID_OR_REPLAYED" as const };
  }

  const recoveryHash = await hashRecoveryCode(code);
  const consumed = input.sessionTokenHash
    ? await pool.query<{ changed: boolean }>("SELECT client_mfa_consume_recovery($1,$2,$3) AS changed", [input.sessionTokenHash,recoveryHash,now])
    : await pool.query(`
    UPDATE user_mfa_recovery_codes
    SET used_at = $3
    WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
    RETURNING id
  `, [input.userId, recoveryHash, now]);
  return (input.sessionTokenHash ? consumed.rows[0]?.changed : consumed.rowCount === 1)
    ? { ok: true as const, level: "recovery" as const }
    : { ok: false as const, code: "INVALID_OR_REPLAYED" as const };
}

export async function getMfaRecoveryStatus(pool: Pool, input: { userId: string; sessionTokenHash?: string }) {
  const result = await pool.query<{
    enabled_at: Date | string | null;
    remaining_recovery_codes: string;
    last_recovery_code_created_at: Date | string | null;
  }>(input.sessionTokenHash ? `
    SELECT enabled_at,remaining_recovery_codes::text,last_recovery_code_created_at
      FROM client_mfa_recovery_status($1)
  ` : `
    SELECT credential.enabled_at,
           count(recovery.id) FILTER (WHERE recovery.used_at IS NULL)::text AS remaining_recovery_codes,
           max(recovery.created_at) AS last_recovery_code_created_at
      FROM user_mfa_totp_credentials AS credential
      LEFT JOIN user_mfa_recovery_codes AS recovery ON recovery.user_id=credential.user_id
     WHERE credential.user_id=$1 AND credential.status='active'
     GROUP BY credential.user_id,credential.enabled_at
  `, [input.sessionTokenHash ?? input.userId]);
  const row = result.rows[0];
  return {
    enrolled: Boolean(row),
    enabledAt: row?.enabled_at ? new Date(row.enabled_at).toISOString() : null,
    remainingRecoveryCodes: row ? Number(row.remaining_recovery_codes) : 0,
    lastRotatedAt: row?.last_recovery_code_created_at ? new Date(row.last_recovery_code_created_at).toISOString() : null,
  };
}

export async function rotateMfaRecoveryCodes(pool: Pool, input: {
  userId: string;
  sessionId: string;
  sessionTokenHash?: string;
  audience: AppAudience;
  reason: string;
  verificationCode?: string;
  environment?: Record<string, string | undefined>;
  now?: Date;
}) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) return { ok: false as const, code: "REASON_INVALID" as const };
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const credential = await client.query(input.sessionTokenHash ? `
      SELECT encrypted_secret FROM client_mfa_credential($1,'active')
    ` : `
      SELECT user_id FROM user_mfa_totp_credentials
       WHERE user_id=$1 AND status='active'
       FOR UPDATE
    `, [input.sessionTokenHash ?? input.userId]);
    if (!credential.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false as const, code: "NOT_ENROLLED" as const };
    }
    if (input.audience === "client") {
      const verificationCode = input.verificationCode?.trim() ?? "";
      if (verificationCode.length < 6 || verificationCode.length > 64) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "VERIFICATION_INVALID" as const };
      }
      const verification = await verifyAndConsumeMfa(client, {
        userId: input.userId,
        sessionTokenHash: input.sessionTokenHash,
        code: verificationCode,
        now,
        environment: input.environment,
      });
      if (!verification.ok) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "VERIFICATION_INVALID" as const };
      }
    }
    const recoveryCodes = generateRecoveryCodes();
    const recoveryHashes = await Promise.all(recoveryCodes.map((code) => hashRecoveryCode(code)));
    if (input.sessionTokenHash) {
      const codes = recoveryHashes.map((codeHash) => ({ id: crypto.randomUUID(), code_hash: codeHash }));
      const replaced = await client.query<{ changed: boolean }>(`
        SELECT client_mfa_replace_recovery($1,$2::jsonb,$3) AS changed
      `, [input.sessionTokenHash,JSON.stringify(codes),now]);
      if (!replaced.rows[0]?.changed) throw new Error("MFA_IDENTITY_STATE_CHANGED");
    } else {
    await client.query("DELETE FROM user_mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL", [input.userId]);
    for (const recoveryHash of recoveryHashes) {
      await client.query(`
        INSERT INTO user_mfa_recovery_codes(id,user_id,code_hash,created_at)
        VALUES($1,$2,$3,$4)
      `, [crypto.randomUUID(), input.userId, recoveryHash, now]);
    }
    }
    await client.query(`
      INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,created_at)
      VALUES($1,$2,'auth.mfa_recovery_rotated','user',$2,$3,$4)
    `, [crypto.randomUUID(), input.userId, JSON.stringify({
      appAudience: input.audience,
      sessionId: input.sessionId,
      recoveryCodesIssued: recoveryCodes.length,
      reason,
    }), now]);
    await client.query("COMMIT");
    return { ok: true as const, recoveryCodes };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
