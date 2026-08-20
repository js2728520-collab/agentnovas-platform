import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login uses database limits, dummy verification, lazy rehash, and assurance deadlines", async () => {
  const source = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(source, /consumeAuthRateLimit/);
  assert.match(source, /dummyVerifyPassword/);
  assert.match(source, /verifyPasswordState/);
  assert.match(source, /needsRehash/);
  assert.match(source, /eq\(users\.passwordHash, user\.passwordHash\)/);
  assert.match(source, /\.\.\.deadlines/);
  assert.match(source, /absoluteExpiresAt/);
  assert.doesNotMatch(source, /7 \* 86400_000/);
});

test("forgot-password is independently database limited without exposing account existence", async () => {
  const source = await readFile(new URL("../app/api/auth/forgot-password/route.ts", import.meta.url), "utf8");
  assert.match(source, /consumeAuthRateLimit/);
  assert.match(source, /forgot_password/);
  assert.doesNotMatch(source, /不存在|未注册/);
});
