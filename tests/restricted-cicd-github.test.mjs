import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RestrictedCicdGithubError,
  computeRestrictedCicdProviderBindingSha256,
  createGithubAppJwt,
  dispatchRestrictedCicdWorkflow,
  dispatchPreparedRestrictedCicdWorkflow,
  loadGithubAppPrivateKey,
  parseRestrictedCicdGithubBinding,
  prepareRestrictedCicdDispatch,
  verifyRestrictedCicdProviderBinding,
  verifyRestrictedCicdWorkflowRun,
  withRestrictedCicdInstallationToken,
} from "../lib/restricted-cicd-github.ts";

const sha = (letter) => letter.repeat(64);
const commit = (letter) => letter.repeat(40);

const baseBinding = (privateKeyFile = "/run/secrets/restricted-cicd-app.pem", overrides = {}) => {
  const binding = {
  provider: "github_actions",
  apiVersion: "2026-03-10",
  apiBaseUrl: "https://api.github.com",
  repositoryOwner: "agentnovas",
  repositoryName: "platform",
  repositoryId: "123456789",
  appId: "24680",
  installationId: "13579",
  accountId: "11223344",
  appPrivateKeyFile: privateKeyFile,
  workflowId: "99887766",
  workflowPath: ".github/workflows/restricted-deployment.yml",
  workflowControlRef: "refs/tags/release-control-v1",
  controlCommitSha: commit("a"),
  workflowSha256: sha("b"),
  environment: "staging",
  oidcAudience: "https://deploy.agentnovas.internal",
  runnerEnvironment: "github-hosted",
  g7ManifestSha256: sha("c"),
  providerBindingSha256: sha("d"),
  environmentPolicySha256: sha("e"),
  productionReviewerAllowlistSha256: sha("f"),
  runnerPolicySha256: sha("1"),
  targetBindingSha256: sha("2"),
  receiptTrustSha256: sha("3"),
  auditorTrustSha256: sha("4"),
  ...overrides,
  };
  binding.providerBindingSha256 = computeRestrictedCicdProviderBindingSha256(binding);
  return binding;
};

function responseJson(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function requestPath(input) {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === "string" ? input : input.url);
  return `${url.pathname}${url.search}`;
}

function exactPermissions() {
  return { actions: "write", contents: "read", metadata: "read" };
}

function requestedPermissions() {
  return { actions: "write", contents: "read" };
}

test("provider binding is strict, fixed to github.com and rejects inline or weak identities", () => {
  const binding = parseRestrictedCicdGithubBinding(baseBinding());
  assert.equal(binding.repositoryId, "123456789");
  assert.equal(binding.apiBaseUrl, "https://api.github.com");
  assert.equal(binding.environment, "staging");

  assert.notEqual(
    baseBinding().providerBindingSha256,
    baseBinding(undefined, { environment: "production" }).providerBindingSha256,
    "staging and production must never share a provider binding digest",
  );

  assert.throws(
    () => parseRestrictedCicdGithubBinding({ ...baseBinding(), extra: true }),
    (error) => error instanceof RestrictedCicdGithubError && error.code === "BINDING_INVALID",
  );
  assert.throws(
    () => parseRestrictedCicdGithubBinding({ ...baseBinding(), apiBaseUrl: "https://github.example.test/api/v3" }),
    /binding invalid/i,
  );
  assert.throws(
    () => parseRestrictedCicdGithubBinding({
      ...baseBinding(), appPrivateKeyFile: ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    }),
    /binding invalid/i,
  );
  assert.throws(
    () => parseRestrictedCicdGithubBinding({ ...baseBinding(), workflowControlRef: "refs/heads/main" }),
    /binding invalid/i,
  );
  assert.throws(
    () => parseRestrictedCicdGithubBinding({ ...baseBinding(), repositoryId: "9007199254740993" }),
    /binding invalid/i,
  );
  assert.throws(
    () => parseRestrictedCicdGithubBinding({ ...baseBinding(), repositoryName: "other-repository" }),
    /binding invalid/i,
  );
  assert.throws(
    () => parseRestrictedCicdGithubBinding({ ...baseBinding(), environment: "preview" }),
    /binding invalid/i,
  );
});

test("dispatch preparation is confined to the binding environment", () => {
  const binding = parseRestrictedCicdGithubBinding(baseBinding());
  assert.throws(
    () => prepareRestrictedCicdDispatch(binding, {
      commandId: "command-cross-environment",
      releaseVersionId: "release-1",
      environment: "production",
      action: "deploy",
      artifactManifestSha256: sha("9"),
      environmentGeneration: 1,
    }),
    (error) => error instanceof RestrictedCicdGithubError
      && error.code === "ENVIRONMENT_MISMATCH",
  );
});

test("private key custody requires an absolute regular non-symlink file with mode at most 0440", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "restricted-cicd-key-"));
  const keyPath = path.join(directory, "app.pem");
  const linkPath = path.join(directory, "link.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  try {
    await writeFile(keyPath, pem, { mode: 0o400 });
    const loaded = await loadGithubAppPrivateKey(keyPath);
    assert.equal(loaded.asymmetricKeyType, "rsa");

    await chmod(keyPath, 0o600);
    await assert.rejects(() => loadGithubAppPrivateKey(keyPath), /private key unavailable/i);
    await chmod(keyPath, 0o400);
    await symlink(keyPath, linkPath);
    await assert.rejects(() => loadGithubAppPrivateKey(linkPath), /private key unavailable/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub App JWT is RS256, short-lived, and uses the bound App id", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = new Date("2026-08-27T12:00:00.000Z");
  const token = createGithubAppJwt(privateKey, "24680", now);
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    iat: Math.floor(now.getTime() / 1000) - 60,
    exp: Math.floor(now.getTime() / 1000) + 540,
    iss: "24680",
  });
  assert.ok(signature.length > 100);
});

test("minting enumerates all installations and narrows the token to one repository and exact permissions", async () => {
  const binding = parseRestrictedCicdGithubBinding(baseBinding());
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls = [];
  const now = new Date("2026-08-27T12:00:00.000Z");
  const fetchImpl = async (input, init = {}) => {
    calls.push({ path: requestPath(input), init });
    const request = calls.at(-1);
    if (request.path === "/app") {
      assert.match(init.headers.authorization, /^Bearer /);
      return responseJson({
        id: 24680,
        owner: { id: 11223344, login: "agentnovas" },
        permissions: exactPermissions(),
      });
    }
    if (request.path === "/app/installations?per_page=100&page=1") {
      return responseJson([{
        id: 13579,
        app_id: 24680,
        account: { id: 11223344, login: "agentnovas" },
        repository_selection: "selected",
        suspended_at: null,
        permissions: exactPermissions(),
      }]);
    }
    if (request.path === "/app/installations/13579/access_tokens") {
      assert.deepEqual(JSON.parse(init.body), {
        repository_ids: [123456789],
        permissions: requestedPermissions(),
      });
      return responseJson({
        token: "github_pat_a_format_that_must_not_be_length_assumed",
        expires_at: "2026-08-27T12:59:00.000Z",
        permissions: exactPermissions(),
        repository_selection: "selected",
        repositories: [{ id: 123456789, full_name: "agentnovas/platform" }],
      }, { status: 201 });
    }
    throw new Error(`unexpected request: ${request.path}`);
  };

  const callbackResult = await withRestrictedCicdInstallationToken(
    binding,
    privateKey,
    { fetchImpl, now },
    async (token) => {
      assert.equal(token, "github_pat_a_format_that_must_not_be_length_assumed");
      return "callback-result";
    },
  );
  assert.equal(callbackResult, "callback-result");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.init.redirect === "error"));
  assert.ok(calls.every((call) => call.init.headers["x-github-api-version"] === "2026-03-10"));
});

test("minting fails closed on a second installation, permission expansion, or suspended binding", async () => {
  const binding = parseRestrictedCicdGithubBinding(baseBinding());
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = {
    id: 24680,
    owner: { id: 11223344, login: "agentnovas" },
    permissions: exactPermissions(),
  };
  const installation = {
    id: 13579,
    app_id: 24680,
    account: { id: 11223344, login: "agentnovas" },
    repository_selection: "selected",
    suspended_at: null,
    permissions: exactPermissions(),
  };
  const fetchImpl = async (input) => {
    const request = requestPath(input);
    if (request === "/app") return responseJson(app);
    if (request.includes("/app/installations?")) {
      return responseJson([installation, { ...installation, id: 99999 }]);
    }
    throw new Error("token mint should not be reached");
  };
  await assert.rejects(
    () => withRestrictedCicdInstallationToken(binding, privateKey, { fetchImpl, now: new Date() }, async () => null),
    (error) => error instanceof RestrictedCicdGithubError && error.code === "PROVIDER_BINDING_DRIFT",
  );
});

test("readiness resolves an annotated control tag and verifies workflow identity and raw content digest", async () => {
  const workflow = "name: restricted\non: workflow_dispatch\n";
  const { createHash } = await import("node:crypto");
  const binding = parseRestrictedCicdGithubBinding(baseBinding(
    "/run/secrets/restricted-cicd-app.pem",
    { workflowSha256: createHash("sha256").update(workflow).digest("hex") },
  ));
  const paths = [];
  const fetchImpl = async (input, init = {}) => {
    const request = requestPath(input);
    paths.push(request);
    assert.equal(init.redirect, "error");
    if (request === "/repos/agentnovas/platform/git/ref/tags/release-control-v1") {
      return responseJson({ ref: binding.workflowControlRef, object: { type: "tag", sha: commit("9") } });
    }
    if (request === `/repos/agentnovas/platform/git/tags/${commit("9")}`) {
      return responseJson({ sha: commit("9"), object: { type: "commit", sha: commit("a") } });
    }
    if (request === "/repos/agentnovas/platform/actions/workflows/99887766") {
      return responseJson({ id: 99887766, path: binding.workflowPath, state: "active" });
    }
    if (request === `/repos/agentnovas/platform/contents/.github/workflows/restricted-deployment.yml?ref=${commit("a")}`) {
      return new Response(workflow, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    throw new Error(`unexpected request: ${request}`);
  };
  const result = await verifyRestrictedCicdProviderBinding(binding, "installation-token", { fetchImpl });
  assert.deepEqual(result, { controlCommitSha: commit("a"), workflowSha256: binding.workflowSha256 });
  assert.equal(paths.length, 4);
});

test("dispatch sends only the fixed envelope and accepts only the exact GitHub run URLs", async () => {
  const binding = parseRestrictedCicdGithubBinding(baseBinding());
  let captured;
  const fetchImpl = async (input, init) => {
    captured = { path: requestPath(input), init };
    return responseJson({
      workflow_run_id: 778899,
      run_url: "https://api.github.com/repos/agentnovas/platform/actions/runs/778899",
      html_url: "https://github.com/agentnovas/platform/actions/runs/778899",
    });
  };
  const snapshot = {
    commandId: "command-1",
    releaseVersionId: "release-1",
    environment: "staging",
    action: "deploy",
    artifactManifestSha256: sha("7"),
    environmentGeneration: 4,
  };
  const dispatched = await dispatchRestrictedCicdWorkflow(binding, "installation-token", snapshot, { fetchImpl });
  assert.deepEqual(dispatched, {
    providerRunId: "778899",
    providerRunUrl: "https://github.com/agentnovas/platform/actions/runs/778899",
    dispatchRequestSha256: dispatched.dispatchRequestSha256,
  });
  assert.match(dispatched.dispatchRequestSha256, /^[a-f0-9]{64}$/);
  assert.equal(captured.path, "/repos/agentnovas/platform/actions/workflows/99887766/dispatches");
  assert.deepEqual(JSON.parse(captured.init.body), {
    ref: "refs/tags/release-control-v1",
    inputs: {
      schema_version: "2",
      command_id: "command-1",
      release_version_id: "release-1",
      environment: "staging",
      action: "deploy",
      artifact_manifest_sha256: sha("7"),
      environment_generation: "4",
    },
  });

  const badFetch = async () => responseJson({
    workflow_run_id: 778899,
    run_url: "https://evil.invalid/run/778899",
    html_url: "https://github.com/agentnovas/platform/actions/runs/778899",
  });
  await assert.rejects(
    () => dispatchRestrictedCicdWorkflow(binding, "installation-token", snapshot, { fetchImpl: badFetch }),
    (error) => error instanceof RestrictedCicdGithubError && error.code === "DISPATCH_OUTCOME_UNKNOWN",
  );

  const prepared = prepareRestrictedCicdDispatch(binding, snapshot);
  const tamperedBody = prepared.requestBody.replace("command-1", "../unsafe-command");
  const { createHash } = await import("node:crypto");
  await assert.rejects(
    () => dispatchPreparedRestrictedCicdWorkflow(binding, "installation-token", {
      requestBody: tamperedBody,
      dispatchRequestSha256: createHash("sha256").update(tamperedBody).digest("hex"),
    }, { fetchImpl: async () => { throw new Error("must not fetch"); } }),
    (error) => error instanceof RestrictedCicdGithubError && error.code === "DISPATCH_REQUEST_INVALID",
  );
});

test("exact run verification binds repository, workflow, event, ref, head SHA, and first attempt", async () => {
  const binding = parseRestrictedCicdGithubBinding(baseBinding());
  const fetchImpl = async () => responseJson({
    id: 778899,
    run_attempt: 1,
    event: "workflow_dispatch",
    head_sha: commit("a"),
    head_branch: "release-control-v1",
    path: `${binding.workflowPath}@release-control-v1`,
    workflow_id: 99887766,
    status: "queued",
    conclusion: null,
    updated_at: "2026-08-27T12:00:00.000Z",
    repository: { id: 123456789, full_name: "agentnovas/platform" },
    url: "https://api.github.com/repos/agentnovas/platform/actions/runs/778899",
    html_url: "https://github.com/agentnovas/platform/actions/runs/778899",
  });
  const result = await verifyRestrictedCicdWorkflowRun(binding, "installation-token", "778899", { fetchImpl });
  assert.deepEqual(result, {
    providerRunId: "778899",
    runAttempt: 1,
    headSha: commit("a"),
    status: "queued",
    conclusion: null,
    updatedAt: "2026-08-27T12:00:00.000Z",
  });

  const rerunFetch = async () => responseJson({
    id: 778899,
    run_attempt: 2,
    event: "workflow_dispatch",
    head_sha: commit("a"),
    head_branch: "release-control-v1",
    path: `${binding.workflowPath}@release-control-v1`,
    workflow_id: 99887766,
    status: "queued",
    conclusion: null,
    updated_at: "2026-08-27T12:00:00.000Z",
    repository: { id: 123456789, full_name: "agentnovas/platform" },
  });
  await assert.rejects(
    () => verifyRestrictedCicdWorkflowRun(binding, "installation-token", "778899", { fetchImpl: rerunFetch }),
    (error) => error instanceof RestrictedCicdGithubError && error.code === "EXACT_RUN_MISMATCH",
  );
});
