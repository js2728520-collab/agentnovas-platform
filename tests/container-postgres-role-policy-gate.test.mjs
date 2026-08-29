import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  planContainerPostgresRolePolicyGate,
  runContainerPostgresRolePolicyGate,
} from "../scripts/release/container-postgres-role-policy-gate.mjs";

const validInput = Object.freeze({
  containerName: "agentnovas-riverton-preview-postgres-1",
  envFile: "/etc/agentnovas-riverton-preview/migrator.env",
  runtimeImage: "agentnovas-riverton-preview-runtime:preview-7c047b6-wt-20260827T013000Z",
});

test("plans a credential-free container-network role-policy command", () => {
  const plan = planContainerPostgresRolePolicyGate(validInput);

  assert.equal(plan.executable, "docker");
  assert.deepEqual(plan.args.slice(0, 5), [
    "run",
    "--rm",
    "--network",
    "container:agentnovas-riverton-preview-postgres-1",
    "--mount",
  ]);
  assert.match(plan.args[5], /^type=bind,src=\/etc\/agentnovas-riverton-preview\/migrator\.env,dst=\/run\/secrets\/agentnovas-migrator\.env,readonly$/);
  assert.ok(plan.args.includes(validInput.runtimeImage));
  assert.ok(plan.args.includes("--env-file=/run/secrets/agentnovas-migrator.env"));
  assert.ok(plan.args.includes("--experimental-strip-types"));
  assert.ok(plan.args.includes("scripts/release/postgres-role-policy.mjs"));

  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(serialized, /password/i);
});

test("rejects ambiguous or unsafe Docker targets", () => {
  assert.throws(
    () => planContainerPostgresRolePolicyGate({ ...validInput, containerName: "../postgres" }),
    /container name/i,
  );
  assert.throws(
    () => planContainerPostgresRolePolicyGate({ ...validInput, runtimeImage: "postgres:latest" }),
    /runtime image/i,
  );
  assert.throws(
    () => planContainerPostgresRolePolicyGate({ ...validInput, envFile: "./migrator.env" }),
    /absolute/i,
  );
  assert.throws(
    () => planContainerPostgresRolePolicyGate({ ...validInput, envFile: "/tmp/migrator,env" }),
    /env file/i,
  );
});

test("accepts an empty-finding role-policy result", () => {
  const calls = [];
  const report = runContainerPostgresRolePolicyGate(validInput, {
    runner(executable, args, options) {
      calls.push({ executable, args, options });
      return {
        status: 0,
        stdout: JSON.stringify({ findings: [] }),
        stderr: "",
      };
    },
  });

  assert.deepEqual(report, { findings: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "docker");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.encoding, "utf8");
});

test("fails closed for command failures, malformed output, or findings", () => {
  assert.throws(
    () => runContainerPostgresRolePolicyGate(validInput, {
      runner: () => ({ status: 17, stdout: "", stderr: "docker failed" }),
    }),
    /exited with status 17/i,
  );
  assert.throws(
    () => runContainerPostgresRolePolicyGate(validInput, {
      runner: () => ({ status: 0, stdout: "not-json", stderr: "" }),
    }),
    /valid JSON/i,
  );
  assert.throws(
    () => runContainerPostgresRolePolicyGate(validInput, {
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ findings: [{ code: "role_login_mismatch" }] }),
        stderr: "",
      }),
    }),
    /reported 1 finding/i,
  );
});

test("CLI dry-run uses a Node-safe migrator env option and never starts Docker", () => {
  const result = spawnSync(process.execPath, [
    "scripts/release/container-postgres-role-policy-gate.mjs",
    `--container=${validInput.containerName}`,
    `--runtime-image=${validInput.runtimeImage}`,
    `--migrator-env-file=${validInput.envFile}`,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.event, "container_postgres_role_policy_plan");
  assert.equal(report.executable, "docker");
});
