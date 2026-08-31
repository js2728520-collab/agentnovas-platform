import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encryptPaymentSecretPayload } from "../packages/ui/src/payment-service-manager/browser-encryption.ts";
import {
  applyPaymentSecretConfigurationToDirectory,
  decryptPaymentSecretEnvelope,
  readManagedUdunRuntimeConfig,
  resolveUdunRuntimeConfig,
} from "../lib/payment-secret-broker.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const configuration = {
  provider: "udun",
  gatewayBaseUrl: "https://sig11.udun.io",
  merchantId: "300015",
  apiKey: "udun_test_key_material_123456",
  callbackUrl: "https://main-test.agentnovas.com/api/integrations/payments/udun/webhook",
  addressRequestCoinField: "mainCoinType",
};
const directConfiguration = { ...configuration, managedConfigurationVersion: null };

test("payment configuration is browser encrypted and validated only inside its broker", async () => {
  const envelope = await encryptPaymentSecretPayload({
    keyId: "payment-broker-test-key", publicKeyPem: publicKey, configuration,
  });
  assert.doesNotMatch(JSON.stringify(envelope), /300015|udun_test|sig11|main-test/);
  assert.deepEqual(await decryptPaymentSecretEnvelope(envelope, {
    keyId: "payment-broker-test-key", privateKeyPem: privateKey,
    allowedCallbackHosts: ["main-test.agentnovas.com"],
  }), directConfiguration);
  await assert.rejects(decryptPaymentSecretEnvelope(envelope, {
    keyId: "wrong-payment-key", privateKeyPem: privateKey,
    allowedCallbackHosts: ["main-test.agentnovas.com"],
  }), /PAYMENT_SECRET_KEY_ID_MISMATCH/);
});

test("payment broker publishes two checksum-bound consumer files and fails closed after manifest creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-payment-secrets-"));
  try {
    const result = await applyPaymentSecretConfigurationToDirectory({
      directory, requestId: "payment-request-12345678", configuration,
      now: new Date("2026-08-29T02:03:04.000Z"),
    });
    assert.match(result.version, /^payment-20260829T020304000Z-/);
    assert.match(result.fingerprint, /^[a-f0-9]{16}$/);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.doesNotMatch(JSON.stringify(manifest), /300015|udun_test|sig11|main-test/);
    assert.equal((await stat(join(directory, manifest.client.file))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, manifest.maintenance.file))).mode & 0o777, 0o600);
    const managedConfiguration = { ...configuration, managedConfigurationVersion: result.version };
    assert.deepEqual(await readManagedUdunRuntimeConfig("client", { PAYMENT_SECRET_DIRECTORY: directory }), managedConfiguration);
    assert.deepEqual(await readManagedUdunRuntimeConfig("maintenance", { PAYMENT_SECRET_DIRECTORY: directory }), managedConfiguration);
    await assert.rejects(readManagedUdunRuntimeConfig("maintenance", {
      PAYMENT_SECRET_DIRECTORY: directory, PAYMENT_SECRET_CONFIGURATION_VERSION: "wrong",
    }), /PAYMENT_SECRET_VERSION_MISMATCH/);
    assert.deepEqual(await resolveUdunRuntimeConfig("client", {
      PAYMENT_SECRET_DIRECTORY: join(directory, "not-yet-populated"),
      UDUN_GATEWAY_BASE_URL: configuration.gatewayBaseUrl,
      UDUN_MERCHANT_ID: configuration.merchantId,
      UDUN_API_KEY: configuration.apiKey,
      UDUN_CALLBACK_URL: configuration.callbackUrl,
      UDUN_ADDRESS_REQUEST_COIN_FIELD: configuration.addressRequestCoinField,
    }), directConfiguration);
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
      ...manifest,
      client: { ...manifest.client, file: `versions/${manifest.version}.client.env/../../stolen.env` },
    })}\n`);
    await assert.rejects(readManagedUdunRuntimeConfig("client", { PAYMENT_SECRET_DIRECTORY: directory }),
      /PAYMENT_SECRET_MANIFEST_INVALID/);
    await writeFile(join(directory, "manifest.json"), "{}\n");
    await assert.rejects(resolveUdunRuntimeConfig("client", {
      PAYMENT_SECRET_DIRECTORY: directory,
      UDUN_GATEWAY_BASE_URL: configuration.gatewayBaseUrl,
      UDUN_MERCHANT_ID: configuration.merchantId,
      UDUN_API_KEY: configuration.apiKey,
      UDUN_CALLBACK_URL: configuration.callbackUrl,
    }), /PAYMENT_SECRET_MANIFEST_INVALID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
