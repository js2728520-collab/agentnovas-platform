import assert from "node:assert/strict";
import test from "node:test";

import {
  dummyVerifyPassword,
  hashPassword,
  verifyPassword,
  verifyPasswordState,
} from "../lib/auth.ts";

const LEGACY_PASSWORD = "legacy-password-123";
const LEGACY_HASH = "pbkdf2-sha256$10000$4b1736f784e0f13a79136d272c9286fc$a0aef7eba1cb671df8f360ae96cb1eff597f3090d8d5b72bf7a251bde8bf66cf";

test("new password hashes use the locked Argon2id profile", async () => {
  const encoded = await hashPassword("correct-horse-battery-staple");
  assert.match(encoded, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword("correct-horse-battery-staple", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
  assert.deepEqual(await verifyPasswordState("correct-horse-battery-staple", encoded), {
    valid: true,
    needsRehash: false,
  });
});

test("legacy PBKDF2 credentials verify once and are marked for lazy upgrade", async () => {
  assert.deepEqual(await verifyPasswordState(LEGACY_PASSWORD, LEGACY_HASH), {
    valid: true,
    needsRehash: true,
  });
  assert.deepEqual(await verifyPasswordState("wrong-password", LEGACY_HASH), {
    valid: false,
    needsRehash: false,
  });
});

test("malformed credentials fail closed and dummy verification follows the Argon2 path", async () => {
  assert.deepEqual(await verifyPasswordState("anything", "not-a-password-hash"), {
    valid: false,
    needsRehash: false,
  });
  assert.equal(await dummyVerifyPassword("unknown-user-password"), false);
});
