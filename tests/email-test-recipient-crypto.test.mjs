import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptEmailTestRecipient,
  emailVerificationCodeMatches,
  encryptEmailTestRecipient,
  hashEmailVerificationCode,
} from "../lib/email-test-recipient-crypto.ts";

const environment = {
  EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY: "test-only-email-recipient-key-with-more-than-32-characters",
};

test("test recipient encryption is randomized, authenticated and environment isolated", async () => {
  const first = await encryptEmailTestRecipient("qa@example.com", environment);
  const second = await encryptEmailTestRecipient("qa@example.com", environment);
  assert.notEqual(first, second);
  assert.equal(await decryptEmailTestRecipient(first, environment), "qa@example.com");
  await assert.rejects(
    decryptEmailTestRecipient(first, { EMAIL_TEST_RECIPIENT_ENCRYPTION_KEY: "different-test-key-with-more-than-32-characters" }),
  );
  assert.doesNotMatch(first, /qa@example\.com/);
});

test("verification codes are context bound and compared without storing plaintext", () => {
  const digest = hashEmailVerificationCode("recipient-1", "042019", environment);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(emailVerificationCodeMatches("recipient-1", "042019", digest, environment), true);
  assert.equal(emailVerificationCodeMatches("recipient-2", "042019", digest, environment), false);
  assert.equal(emailVerificationCodeMatches("recipient-1", "042018", digest, environment), false);
  assert.doesNotMatch(digest, /042019/);
});
