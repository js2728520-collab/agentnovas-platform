import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSecretEnvelope } from "../packages/ai-control-plane/src/index.ts";
import { processSecretEnvelope } from "../lib/ai-secret-broker.ts";

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function privatePem(bytes) {
  const encoded = base64(bytes).match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
}

test("browser envelope encryption and Broker custody never persist plaintext in the command", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const directory = await mkdtemp(join(tmpdir(), "ai-secret-broker-"));
  try {
    const command = await createSecretEnvelope({
      commandId: "command-1",
      targetConnectionRevisionId: "connection-revision-1",
      brokerKeyId: "broker-key-1",
      publicKeySpkiBase64: base64(await crypto.subtle.exportKey("spki", keyPair.publicKey)),
      secret: "provider-key-quality-only",
    });
    assert.equal(JSON.stringify(command).includes("provider-key-quality-only"), false);

    const receipt = await processSecretEnvelope(command, {
      brokerPrivateKeyPem: privatePem(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)),
      managedDirectory: directory,
      brokerInstanceId: "broker-test",
    });
    assert.equal(JSON.stringify(receipt).includes("provider-key-quality-only"), false);
    assert.match(receipt.secretRef, /^managed:\/\/ai\/[a-f0-9]{64}\.secret$/);
    assert.match(receipt.secretFingerprint, /^[a-f0-9]{64}$/);
    const fileName = receipt.secretRef.slice("managed://ai/".length);
    assert.equal(await readFile(join(directory, fileName), "utf8"), "provider-key-quality-only");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, fileName))).mode & 0o777, 0o600);

    const replay = await processSecretEnvelope(command, {
      brokerPrivateKeyPem: privatePem(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)),
      managedDirectory: directory,
      brokerInstanceId: "broker-test",
    });
    assert.equal(replay.secretRef, receipt.secretRef);
    assert.equal(replay.secretFingerprint, receipt.secretFingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Broker returns a stable safe error for invalid envelopes", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const otherKeyPair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const directory = await mkdtemp(join(tmpdir(), "ai-secret-broker-invalid-"));
  try {
    const command = await createSecretEnvelope({
      commandId: "command-invalid",
      targetConnectionRevisionId: "connection-revision-invalid",
      brokerKeyId: "broker-key-1",
      publicKeySpkiBase64: base64(await crypto.subtle.exportKey("spki", keyPair.publicKey)),
      secret: "must-not-appear-in-error",
    });
    await assert.rejects(
      processSecretEnvelope(command, {
        brokerPrivateKeyPem: privatePem(await crypto.subtle.exportKey("pkcs8", otherKeyPair.privateKey)),
        managedDirectory: directory,
        brokerInstanceId: "broker-test",
      }),
      (error) => error?.code === "AI_SECRET_DECRYPT_FAILED" && !String(error).includes("must-not-appear-in-error"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
