import assert from "node:assert/strict";
import test from "node:test";

import { invokeRestrictedCicdControlGateway } from "../lib/restricted-cicd-control-gateway-client.ts";

const environment = Object.freeze({
  RELEASE_IDENTITY_VERIFIER_URL: "http://release-identity-verifier:3315",
  RELEASE_IDENTITY_VERIFIER_SHARED_SECRET: "identity-verifier-shared-secret-000000000001",
  RELEASE_CONTROL_GATEWAY_URL: "http://release-control:3314",
  RELEASE_CONTROL_GATEWAY_SHARED_SECRET: "release-control-shared-secret-0000000000001",
});

function input(request) {
  return {
    request, operation: "stop.request", actorUserId: "human-release-checker",
    sessionSecret: "maintenance-session-secret-at-least-32-characters",
    idempotencyKey: "stop:staging:fixed-idempotency-key", requestId: "fixed-request-id-0001",
    parameters: { environment: "staging" }, body: { reason: "Stop staging for exact quality verification" },
  };
}

test("Maintenance coordinator sends the exact envelope through verifier then executor", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), authorization: init.headers.authorization });
    if (calls.length === 1) return Response.json({ result: { assertionId: "release-assertion-quality-1", mutationSha256: "a".repeat(64) } });
    return Response.json({ result: { generation: 8, replayed: false } });
  };
  try {
    const request = new Request("https://main-test.agentnovas.com/api/maintenance/release-workflow/stops", { headers: {
      "x-request-id": "fixed-request-id-0001",
      "x-release-webauthn-challenge-id": "release-assertion-quality-1",
      "x-release-webauthn-credential-id": "credential-quality-0001",
      "x-release-webauthn-client-data": "client-data-quality-0001",
      "x-release-webauthn-authenticator-data": "authenticator-data-quality-0001",
      "x-release-webauthn-signature": "signature-quality-0001",
    } });
    assert.deepEqual(await invokeRestrictedCicdControlGateway(input(request), environment, {
      issueAuthority: async () => "release-authority-" + "b".repeat(48),
    }), { generation: 8, replayed: false });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "http://release-identity-verifier:3315/v1/assertions");
    assert.equal(calls[1].url, "http://release-control:3314/v1/mutations");
    assert.equal(calls[0].body.authorityId, "release-authority-" + "b".repeat(48));
    assert.equal(calls[0].body.mutationDocument.includes("maintenance-session-secret"), false);
    assert.equal(JSON.stringify(calls[0].body).includes("maintenance-session-secret-at-least-32-characters"), false);
    assert.equal(calls[1].body.envelope.requestId, "fixed-request-id-0001");
    assert.equal(calls[0].body.assertion.challengeId, "release-assertion-quality-1");
    assert.equal(calls[1].body.assertionId, "release-assertion-quality-1");
    assert.equal(calls[1].body.mutationSha256, "a".repeat(64));
    assert.notEqual(calls[0].authorization, calls[1].authorization);
  } finally { globalThis.fetch = originalFetch; }
});

test("challenge response stops before the executor and is preserved for the browser", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ error: { code: "WEBAUTHN_ACTION_REQUIRED", message: "sign", details: { webAuthn: {
      challengeId: "release-assertion-quality-2", challenge: "challenge-quality-2", rpId: "main-test.agentnovas.com",
      credentialIds: ["credential-quality-0001"], timeout: 120000, userVerification: "required",
    } } } }, { status: 428 });
  };
  try {
    await assert.rejects(
      invokeRestrictedCicdControlGateway(input(new Request("https://main-test.agentnovas.com/api/maintenance/release-workflow/stops")), environment, {
        issueAuthority: async () => "release-authority-" + "c".repeat(48),
      }),
      (error) => error?.code === "WEBAUTHN_ACTION_REQUIRED" && error?.status === 428,
    );
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
