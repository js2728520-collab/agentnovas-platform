import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseRestrictedCicdAuditorPolicy } from "../../lib/restricted-cicd-auditor.ts";
import { parseRestrictedCicdGithubBinding } from "../../lib/restricted-cicd-github.ts";

function environment(value) {
  if (value !== "staging" && value !== "production") {
    throw new Error("restricted CI/CD instance environment invalid");
  }
  return value;
}

async function custodiedJson(filePath) {
  if (!path.isAbsolute(filePath) || filePath.length > 500 || filePath.includes("\0")) {
    throw new Error("restricted CI/CD instance file path invalid");
  }
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 128 * 1024
    || (metadata.mode & 0o022) !== 0) {
    throw new Error("restricted CI/CD instance file custody invalid");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function verifyRestrictedCicdInstanceConfig(input) {
  const expectedEnvironment = environment(input.environment);
  const binding = parseRestrictedCicdGithubBinding(input.binding);
  const policy = parseRestrictedCicdAuditorPolicy(input.policy);
  const exactPairs = [
    [binding.environment, policy.environment],
    [binding.repositoryOwner, policy.repositoryOwner],
    [binding.repositoryName, policy.repositoryName],
    [binding.repositoryId, policy.repositoryId],
    [binding.accountId, policy.accountId],
    [binding.workflowId, policy.workflowId],
    [binding.controlCommitSha, policy.controlCommitSha],
    [binding.runnerEnvironment, policy.runnerEnvironment],
    [binding.environmentPolicySha256, policy.environmentPolicySha256],
    [binding.runnerPolicySha256, policy.runnerPolicySha256],
  ];
  if (binding.environment !== expectedEnvironment || policy.environment !== expectedEnvironment
    || exactPairs.some(([left, right]) => left !== right)) {
    throw new Error("restricted CI/CD Worker/Auditor instance binding mismatch");
  }
  return Object.freeze({
    schemaVersion: "1",
    environment: expectedEnvironment,
    repositoryId: binding.repositoryId,
    workflowId: binding.workflowId,
    controlCommitSha: binding.controlCommitSha,
    providerBindingSha256: binding.providerBindingSha256,
    environmentPolicySha256: binding.environmentPolicySha256,
    runnerPolicySha256: binding.runnerPolicySha256,
  });
}

export async function verifyRestrictedCicdInstanceConfigFiles(input) {
  const [binding, policy] = await Promise.all([
    custodiedJson(input.bindingFile),
    custodiedJson(input.policyFile),
  ]);
  return verifyRestrictedCicdInstanceConfig({ environment: input.environment, binding, policy });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) {
    process.stderr.write("usage: restricted-cicd-instance-config <environment> <binding-file> <auditor-policy-file>\n");
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyRestrictedCicdInstanceConfigFiles({
        environment: process.argv[2],
        bindingFile: process.argv[3],
        policyFile: process.argv[4],
      });
      process.stdout.write(`${JSON.stringify({
        event: "restricted_cicd_instance_config_verified",
        ...result,
      })}\n`);
    } catch {
      process.stderr.write("restricted CI/CD instance configuration invalid\n");
      process.exitCode = 1;
    }
  }
}
