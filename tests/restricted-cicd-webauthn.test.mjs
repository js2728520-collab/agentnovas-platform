import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseRestrictedCicdWebAuthnAssertion,
  parseRestrictedCicdWebAuthnPolicy,
  verifyRestrictedCicdWebAuthnAssertion,
} from "../lib/restricted-cicd-webauthn.ts";

const rpId = "main-test.agentnovas.com";
const origin = `https://${rpId}`;
const credentialId = randomBytes(32).toString("base64url");
const challenge = randomBytes(32).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const policy = parseRestrictedCicdWebAuthnPolicy({
  schemaVersion: "1", rpId, allowedOrigins: [origin], credentials: [{
    credentialId, userId: "human-release-checker", algorithm: "ES256",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  }],
});

function assertion(overrides = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge, origin, crossOrigin: false,
    ...(overrides.clientData ?? {}),
  }));
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(authenticatorData, 0);
  authenticatorData[32] = overrides.flags ?? 0x05;
  authenticatorData.writeUInt32BE(overrides.signCount ?? 7, 33);
  const signer = createSign("SHA256");
  signer.update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]));
  signer.end();
  return parseRestrictedCicdWebAuthnAssertion({
    challengeId: "release-assertion-quality-1", credentialId,
    clientDataJSON: clientDataJSON.toString("base64url"),
    authenticatorData: authenticatorData.toString("base64url"),
    signature: signer.sign(privateKey).toString("base64url"),
  });
}

test("WebAuthn release assertion verifies RP, origin, UV, challenge, actor and signature", () => {
  const verified = verifyRestrictedCicdWebAuthnAssertion({
    policy, assertion: assertion(), expectedChallenge: challenge,
    expectedUserId: "human-release-checker", previousSignCount: 6,
  });
  assert.equal(verified.credential.userId, "human-release-checker");
  assert.equal(verified.signCount, 7);
  assert.equal(verified.origin, origin);
});

test("WebAuthn release assertion rejects wrong binding, absent UV and counter replay", () => {
  assert.throws(() => verifyRestrictedCicdWebAuthnAssertion({ policy, assertion: assertion(),
    expectedChallenge: randomBytes(32).toString("base64url"), expectedUserId: "human-release-checker" }), /client binding/i);
  assert.throws(() => verifyRestrictedCicdWebAuthnAssertion({ policy, assertion: assertion({ flags: 0x01 }),
    expectedChallenge: challenge, expectedUserId: "human-release-checker" }), /user verification/i);
  assert.throws(() => verifyRestrictedCicdWebAuthnAssertion({ policy, assertion: assertion({ signCount: 7 }),
    expectedChallenge: challenge, expectedUserId: "human-release-checker", previousSignCount: 7 }), /counter replayed/i);
  assert.throws(() => verifyRestrictedCicdWebAuthnAssertion({ policy, assertion: assertion(),
    expectedChallenge: challenge, expectedUserId: "different-human" }), /credential unavailable/i);
});

test("Maintenance coordinates independent identity and mutation services without either database credential", async () => {
  const [maintenanceEnvironment, releaseEnvironment, identityEnvironment, maintenanceUnit, compose, routes, client, gateway, verifier] = await Promise.all([
    readFile(new URL("../deploy/env/maintenance.env.example", import.meta.url), "utf8"),
    readFile(new URL("../deploy/env/release-control.env.example", import.meta.url), "utf8"),
    readFile(new URL("../deploy/env/release-identity-verifier.env.example", import.meta.url), "utf8"),
    readFile(new URL("../deploy/systemd/riverton-maintenance.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/container/compose.yml", import.meta.url), "utf8"),
    (await import("node:fs/promises")).readdir(new URL("../app/api/maintenance/release-workflow", import.meta.url), { recursive: true })
      .then((names) => names.filter((name) => name.endsWith("route.maintenance.ts") && name !== "route.maintenance.ts"))
      .then((names) => Promise.all(names.map((name) => readFile(new URL(`../app/api/maintenance/release-workflow/${name}`, import.meta.url), "utf8"))))
      .then((sources) => sources.join("\n")),
    readFile(new URL("../lib/restricted-cicd-control-gateway-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release-control-gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release-identity-verifier.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(maintenanceEnvironment, /RELEASE_CONTROL_DATABASE_URL/);
  assert.doesNotMatch(maintenanceEnvironment, /RELEASE_IDENTITY_VERIFIER_DATABASE_URL/);
  assert.match(releaseEnvironment, /RELEASE_CONTROL_DATABASE_URL=postgresql:\/\/agentnovas_release_control/);
  assert.match(identityEnvironment, /RELEASE_IDENTITY_VERIFIER_DATABASE_URL=postgresql:\/\/agentnovas_release_identity_verifier/);
  assert.doesNotMatch(identityEnvironment, /RELEASE_CONTROL_GATEWAY_SHARED_SECRET|RELEASE_CONTROL_DATABASE_URL/);
  assert.doesNotMatch(releaseEnvironment, /RELEASE_IDENTITY_VERIFIER_SHARED_SECRET|WEBAUTHN_POLICY/);
  assert.doesNotMatch(maintenanceUnit, /release-control\.env|agentnovas_release_control/);
  assert.match(compose, /release-identity-verifier:/);
  assert.match(compose, /release-control:/);
  assert.doesNotMatch(maintenanceUnit, /RELEASE_CONTROL_GATEWAY_URL|RELEASE_IDENTITY_VERIFIER_URL/);
  assert.doesNotMatch(routes, /getReleaseControlPostgresPool|restricted-cicd-maintenance-service/);
  assert.match(routes, /invokeRestrictedCicdControlGateway/);
  assert.match(client, /release-identity-verifier/);
  assert.match(client, /release-control/);
  assert.match(client, /release_workflow_issue_human_action_authority/);
  assert.match(client, /mutationDocument/);
  assert.match(gateway, /release_workflow_execute_human_action/);
  assert.doesNotMatch(gateway, /verifyRestrictedCicdWebAuthnAssertion|record_human_action_assertion/);
  assert.match(verifier, /verifyRestrictedCicdWebAuthnAssertion/);
  assert.match(verifier, /release_workflow_record_human_action_assertion/);
  assert.match(verifier, /release_workflow_resolve_human_action_assertion/);
  assert.doesNotMatch(verifier, /sessionSecret|RELEASE_CONTROL_GATEWAY_SHARED_SECRET/);
  assert.doesNotMatch(verifier, /release_workflow_execute_human_action|requestRestrictedCicdActivation/);
});
