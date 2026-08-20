import { hash as argon2Hash, verify as argon2Verify, type Options as Argon2Options } from "@node-rs/argon2";

const encoder = new TextEncoder();

const ARGON2_OPTIONS = {
  algorithm: 2 as Argon2Options["algorithm"],
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

// A valid hash with no corresponding account. Unknown identifiers must still
// traverse the memory-hard verification path to limit username enumeration by
// response timing.
const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$uZGNMDR+JrV5Qg7kYNBIpw$kXMEbVFfG6Rz1Ep94BpivMh29vL/eastot6wMZ/adaY";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error("Invalid encoded value");
  return new Uint8Array(hex.match(/.{2}/g)!.map(x => Number.parseInt(x, 16)));
}

export function randomToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToHex(value);
}

export async function sha256(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function hashPassword(password: string) {
  if (password.length < 10 || password.length > 128) throw new Error("Password must be 10-128 characters");
  return argon2Hash(password, ARGON2_OPTIONS);
}

async function verifyLegacyPbkdf2(password: string, encoded: string) {
  const [algorithm, rounds, saltHex, expectedHex] = encoded.split("$");
  if (algorithm !== "pbkdf2-sha256" || !rounds || !saltHex || !expectedHex) return false;
  const iterations = Number(rounds);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
    const actual = new Uint8Array(bits); const expected = hexToBytes(expectedHex);
    if (actual.length !== expected.length) return false;
    let diff = 0; for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export async function verifyPasswordState(password: string, encoded: string) {
  if (encoded.startsWith("$argon2id$")) {
    try {
      return { valid: await argon2Verify(encoded, password), needsRehash: false };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }
  const valid = await verifyLegacyPbkdf2(password, encoded);
  return { valid, needsRehash: valid };
}

export async function verifyPassword(password: string, encoded: string) {
  return (await verifyPasswordState(password, encoded)).valid;
}

export async function dummyVerifyPassword(password: string) {
  try {
    return await argon2Verify(DUMMY_PASSWORD_HASH, password);
  } catch {
    return false;
  }
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
