import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  RestrictedCicdIngressError,
  parseRestrictedCicdIngressBinding,
  processRestrictedCicdGithubWebhook,
  verifyRestrictedCicdWebhookSignature,
} from "../lib/restricted-cicd-ingress.ts";

const binding = parseRestrictedCicdIngressBinding({
  provider: "github_actions",
  repositoryOwner: "agentnovas",
  repositoryName: "platform",
  repositoryId: "123456789",
  workflowId: "99887766",
  workflowPath: ".github/workflows/restricted-deployment.yml",
  workflowControlRef: "refs/tags/release-control-v1",
  controlCommitSha: "a".repeat(40),
  webhookSecretFile: "/run/secrets/release-ingress-webhook-secret",
});

function payload(overrides = {}) {
  return {
    action: "completed",
    repository: {
      id: 123456789,
      full_name: "agentnovas/platform",
      owner: { login: "agentnovas" },
    },
    workflow_run: {
      id: 778899,
      workflow_id: 99887766,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: ".github/workflows/restricted-deployment.yml@release-control-v1",
      head_sha: "a".repeat(40),
      head_branch: "release-control-v1",
      status: "completed",
      conclusion: "success",
    },
    ...overrides,
  };
}

function signedRequest(body, secret = Buffer.from("It's a Secret to Everybody")) {
  return {
    rawBody: body,
    headers: {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/abc123",
      "x-github-event": "workflow_run",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "x-github-hook-installation-target-type": "repository",
      "x-github-hook-installation-target-id": binding.repositoryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  };
}

test("HMAC verification matches GitHub's official raw-body vector", () => {
  assert.equal(verifyRestrictedCicdWebhookSignature(
    Buffer.from("It's a Secret to Everybody"),
    Buffer.from("Hello, World!"),
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
  ), true);
  assert.equal(verifyRestrictedCicdWebhookSignature(
    Buffer.from("It's a Secret to Everybody"),
    Buffer.from("Hello, world!"),
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
  ), false);
});

test("signed exact workflow_run is normalized and appended without raw payload", async () => {
  const rawBody = Buffer.from(JSON.stringify(payload()));
  const calls = [];
  const result = await processRestrictedCicdGithubWebhook({
    binding,
    webhookSecret: Buffer.from("It's a Secret to Everybody"),
    database: { appendDelivery: async (delivery) => { calls.push(delivery); return { replayed: false }; } },
    ...signedRequest(rawBody),
  });
  assert.deepEqual(result, { accepted: true, replayed: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    eventName: "workflow_run",
    action: "completed",
    repositoryId: "123456789",
    workflowId: "99887766",
    runId: "778899",
    runAttempt: 1,
    headSha: "a".repeat(40),
    headRef: "release-control-v1",
    status: "completed",
    conclusion: "success",
    bodySha256: createHash("sha256").update(rawBody).digest("hex"),
    payloadSizeBytes: rawBody.byteLength,
  });
  assert.equal("rawBody" in calls[0], false);
});

test("signature is checked before JSON and all locator/action drift fails closed", async () => {
  const database = { appendDelivery: async () => { throw new Error("must not append"); } };
  await assert.rejects(
    processRestrictedCicdGithubWebhook({
      binding,
      webhookSecret: Buffer.from("It's a Secret to Everybody"),
      database,
      rawBody: Buffer.from("not-json"),
      headers: { ...signedRequest(Buffer.from("different")).headers },
    }),
    (error) => error instanceof RestrictedCicdIngressError && error.code === "WEBHOOK_UNAUTHORIZED",
  );
  for (const changed of [
    { action: "rerequested" },
    { repository: { ...payload().repository, id: 999 } },
    { workflow_run: { ...payload().workflow_run, run_attempt: 2 } },
    { workflow_run: { ...payload().workflow_run, head_sha: "b".repeat(40) } },
  ]) {
    const rawBody = Buffer.from(JSON.stringify(payload(changed)));
    await assert.rejects(
      processRestrictedCicdGithubWebhook({
        binding,
        webhookSecret: Buffer.from("It's a Secret to Everybody"),
        database,
        ...signedRequest(rawBody),
      }),
      (error) => error instanceof RestrictedCicdIngressError && error.code === "WEBHOOK_PAYLOAD_REJECTED",
    );
  }
});

test("oversized bodies, malformed headers, and replay collisions are rejected", async () => {
  const secret = Buffer.from("It's a Secret to Everybody");
  const database = { appendDelivery: async () => { throw new Error("delivery replay mismatch"); } };
  const rawBody = Buffer.from(JSON.stringify(payload()));
  await assert.rejects(processRestrictedCicdGithubWebhook({
    binding,
    webhookSecret: secret,
    database,
    ...signedRequest(Buffer.alloc(256 * 1024 + 1), secret),
  }), /payload rejected/i);
  await assert.rejects(processRestrictedCicdGithubWebhook({
    binding,
    webhookSecret: secret,
    database,
    ...signedRequest(rawBody, secret),
    headers: { ...signedRequest(rawBody, secret).headers, "x-github-delivery": "not-a-guid" },
  }), /payload rejected/i);
  await assert.rejects(processRestrictedCicdGithubWebhook({
    binding,
    webhookSecret: secret,
    database,
    ...signedRequest(rawBody, secret),
  }), /delivery replay mismatch/i);
});
