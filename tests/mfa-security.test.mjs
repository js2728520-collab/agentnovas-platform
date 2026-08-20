import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  totpCode,
} from "../lib/mfa.ts";

const environment = { MFA_TOTP_ENCRYPTION_KEY: "test-only-key-that-is-longer-than-thirty-two-characters" };

test("TOTP follows the RFC 6238 SHA-1 test vector", async () => {
  assert.equal(await totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1, 8), "94287082");
});
test("TOTP secrets are AES-GCM encrypted with a dedicated key", async () => {
  const encrypted = await encryptTotpSecret("JBSWY3DPEHPK3PXP", environment);
  assert.match(encrypted, /^v1\./);
  assert.doesNotMatch(encrypted, /JBSWY3DPEHPK3PXP/);
  assert.equal(await decryptTotpSecret(encrypted, environment), "JBSWY3DPEHPK3PXP");
  await assert.rejects(() => decryptTotpSecret(encrypted, {}), /MFA.*加密密钥/);
});

test("recovery codes have high entropy and only stable hashes need storage", async () => {
  const codes = generateRecoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  assert.ok(codes.every((code) => /^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{6}$/.test(code)));
  const hash = await hashRecoveryCode(codes[0]);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(hash, new RegExp(codes[0].replaceAll("-", ""), "i"));
});
