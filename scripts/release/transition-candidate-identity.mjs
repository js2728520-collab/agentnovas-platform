import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { normalizeReleaseVersion } from "./release-identity.mjs";

function parseSemver(input) {
  const normalized = normalizeReleaseVersion(input).version;
  const [coreAndPrerelease] = normalized.split("+");
  const prereleaseSeparator = coreAndPrerelease.indexOf("-");
  const core = prereleaseSeparator === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease = prereleaseSeparator === -1 ? "" : coreAndPrerelease.slice(prereleaseSeparator + 1);
  const [major, minor, patch] = core.split(".").map(BigInt);
  return {
    normalized,
    core: [major, minor, patch],
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right);
}

export function compareSemver(leftInput, rightInput) {
  const left = parseSemver(leftInput);
  const right = parseSemver(rightInput);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return Math.sign(comparison);
  }
  return 0;
}

export function normalizeTransitionCandidate({ branch, version, commitSha, releasedVersions = [] }) {
  const normalized = normalizeReleaseVersion(version);
  const normalizedBranch = String(branch ?? "").trim();
  const expectedBranch = `codex/release-transition-${normalized.versionTag}`;
  if (normalizedBranch !== expectedBranch) {
    throw new Error(`Release candidate must run from transition branch ${expectedBranch}`);
  }
  const normalizedCommit = String(commitSha ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedCommit)) {
    throw new Error("Release candidate commit must be a full 40-character Git SHA");
  }
  const released = releasedVersions.map((releasedVersion) => normalizeReleaseVersion(releasedVersion).version);
  if (released.some((releasedVersion) => compareSemver(normalized.version, releasedVersion) <= 0)) {
    throw new Error("Transition candidate version must be newer than every released version");
  }
  const candidateTag = `candidate-${normalized.version}-${normalizedCommit}`;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(candidateTag)) {
    throw new Error("Transition candidate must produce a valid Docker tag of at most 128 characters");
  }
  return {
    ...normalized,
    branch: normalizedBranch,
    commitSha: normalizedCommit,
    candidateTag,
    runtimeVersionTag: normalized.version.includes("-")
      ? `${normalized.versionTag}.candidate.${normalizedCommit.slice(0, 12)}`
      : `${normalized.versionTag}-candidate.${normalizedCommit.slice(0, 12)}`,
  };
}

function git(...argumentsList) {
  return execFileSync("git", argumentsList, { encoding: "utf8" }).trim();
}

async function candidateIdentity() {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const changelog = await readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const branch = process.env.GITHUB_REF_NAME?.trim() || git("branch", "--show-current");
  const commitSha = process.env.GITHUB_SHA?.trim() || git("rev-parse", "HEAD");
  const releasedVersions = git("tag", "--list", "v*")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const dirty = git("status", "--porcelain");
  if (dirty) throw new Error("Transition candidate identity requires a clean Git worktree");
  if (!/^## \[Unreleased\]\n\n(?=### |[-*] )/m.test(changelog)) {
    throw new Error("CHANGELOG.md must contain a non-empty Unreleased section");
  }
  const migrations = (await readdir(new URL("../../postgres/migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (!migrations.length) throw new Error("No production PostgreSQL migrations were found");
  return {
    ...normalizeTransitionCandidate({
      branch,
      version: packageJson.version,
      commitSha,
      releasedVersions,
    }),
    migrationVersion: migrations.at(-1).slice(0, 4),
  };
}

async function main() {
  process.stdout.write(`${JSON.stringify(await candidateIdentity())}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Transition candidate identity failed"}\n`);
    process.exitCode = 1;
  });
}
