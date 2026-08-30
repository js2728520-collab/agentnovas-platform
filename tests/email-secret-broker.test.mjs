import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { encryptEmailSecretPayload } from "../packages/ui/src/email-service-manager/browser-encryption.ts";
import {
  applyEmailSecretConfigurationToDirectory,
  decryptEmailSecretEnvelope,
  readManagedEmailSecret,
  resolveEmailSecret,
} from "../lib/email-secret-broker.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("browser encryption can be decrypted only by the broker private key", async () => {
  const envelope = await encryptEmailSecretPayload({
    keyId: "email-broker-test-key",
    publicKeyPem: publicKey,
    resendApiKey: "re_test_key_material_123456",
    resendWebhookSecret: "whsec_test_secret_material_123456",
  });
  assert.doesNotMatch(JSON.stringify(envelope), /re_test|whsec_test/);
  assert.deepEqual(await decryptEmailSecretEnvelope(envelope, {
    keyId: "email-broker-test-key",
    privateKeyPem: privateKey,
  }), {
    resendApiKey: "re_test_key_material_123456",
    resendWebhookSecret: "whsec_test_secret_material_123456",
  });
  await assert.rejects(decryptEmailSecretEnvelope(envelope, {
    keyId: "different-key-id",
    privateKeyPem: privateKey,
  }), /EMAIL_SECRET_KEY_ID_MISMATCH/);
});

test("broker publishes a complete version atomically and consumers verify checksums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-email-secrets-"));
  try {
    const result = await applyEmailSecretConfigurationToDirectory({
      directory,
      requestId: "request-12345678",
      resendApiKey: "re_test_key_material_123456",
      resendWebhookSecret: "whsec_test_secret_material_123456",
      now: new Date("2026-08-29T01:02:03.000Z"),
    });
    assert.match(result.version, /^email-20260829T010203000Z-/);
    assert.match(result.fingerprint, /^[a-f0-9]{16}$/);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.version, result.version);
    assert.doesNotMatch(JSON.stringify(manifest), /re_test|whsec_test/);
    assert.equal((await stat(join(directory, manifest.notification.file))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, manifest.maintenance.file))).mode & 0o777, 0o600);
    assert.equal(await readManagedEmailSecret("notification", { EMAIL_SECRET_DIRECTORY: directory }), "re_test_key_material_123456");
    assert.equal(await readManagedEmailSecret("maintenance", { EMAIL_SECRET_DIRECTORY: directory }), "whsec_test_secret_material_123456");
    await assert.rejects(
      readManagedEmailSecret("notification", { EMAIL_SECRET_DIRECTORY: directory, EMAIL_SECRET_CONFIGURATION_VERSION: "wrong" }),
      /EMAIL_SECRET_VERSION_MISMATCH/,
    );
    assert.equal(await resolveEmailSecret("notification",{
      EMAIL_SECRET_DIRECTORY: join(directory,"not-yet-populated"),RESEND_API_KEY: "re_migration_fallback_123456",
    }),"re_migration_fallback_123456");
    await writeFile(join(directory,"manifest.json"),"{}\n");
    await assert.rejects(resolveEmailSecret("notification",{
      EMAIL_SECRET_DIRECTORY: directory,RESEND_API_KEY: "re_stale_value_must_not_revive",
    }),/EMAIL_SECRET_MANIFEST_INVALID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
