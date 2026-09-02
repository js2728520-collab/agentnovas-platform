import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compareSemver,
  normalizeTransitionCandidate,
} from "../scripts/release/transition-candidate-identity.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("transition candidates bind the branch, package version and full commit", () => {
  const candidate = normalizeTransitionCandidate({
    branch: "codex/release-transition-v1.0.0-beta.7",
    version: "1.0.0-beta.7",
    commitSha: "a".repeat(40),
    releasedVersions: ["1.0.0-beta.5", "1.0.0-beta.6"],
  });

  assert.deepEqual(candidate, {
    version: "1.0.0-beta.7",
    versionTag: "v1.0.0-beta.7",
    branch: "codex/release-transition-v1.0.0-beta.7",
    commitSha: "a".repeat(40),
    candidateTag: `candidate-1.0.0-beta.7-${"a".repeat(40)}`,
    runtimeVersionTag: `v1.0.0-beta.7.candidate.${"a".repeat(12)}`,
  });
  assert.throws(() => normalizeTransitionCandidate({
    branch: "main",
    version: "1.0.0-beta.7",
    commitSha: "a".repeat(40),
    releasedVersions: ["1.0.0-beta.6"],
  }), /transition branch/i);
  assert.throws(() => normalizeTransitionCandidate({
    branch: "codex/release-transition-v1.0.0-beta.6",
    version: "1.0.0-beta.6",
    commitSha: "a".repeat(40),
    releasedVersions: ["1.0.0-beta.6"],
  }), /newer than every released version/i);
  assert.throws(() => normalizeTransitionCandidate({
    branch: "codex/release-transition-v1.0.0-beta.7+build.1",
    version: "1.0.0-beta.7+build.1",
    commitSha: "a".repeat(40),
    releasedVersions: ["1.0.0-beta.6"],
  }), /Docker tag/i);
  assert.equal(normalizeTransitionCandidate({
    branch: "codex/release-transition-v2.0.0",
    version: "2.0.0",
    commitSha: "b".repeat(40),
    releasedVersions: ["1.9.9"],
  }).runtimeVersionTag, `v2.0.0-candidate.${"b".repeat(12)}`);
});

test("SemVer ordering handles prerelease identifiers deterministically", () => {
  assert.equal(compareSemver("1.0.0-beta.7", "1.0.0-beta.6"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0-beta.7"), 1);
  assert.equal(compareSemver("1.0.0-beta.7", "1.0.0-beta.7"), 0);
  assert.equal(compareSemver("1.0.0-beta.7.2", "1.0.0-beta.7.10"), -1);
  assert.equal(compareSemver("1.0.0-alpha-long.1", "1.0.0-alpha-long.0"), 1);
  assert.equal(compareSemver("9007199254740993.0.0", "9007199254740992.0.0"), 1);
  assert.equal(compareSemver("1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992"), 1);
});

test("the preview candidate workflow verifies before publishing immutable images", async () => {
  const workflow = await read(".github/workflows/preview-candidate.yml");
  assert.match(workflow, /branches:\s*\["codex\/release-transition-v\*"\]/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\s*\n\s+contents:\s*read\s*\n\s+packages:\s*write/);
  assert.match(workflow, /needs:\s*\[identity, verify\]/);
  assert.match(workflow, /release:candidate-identity/);
  assert.match(workflow, /push:\s*true/);
  assert.match(workflow, /\$\{\{ needs\.identity\.outputs\.candidate_tag \}\}/);
  assert.match(workflow, /test\.agentnovas\.com/);
  assert.match(workflow, /ops-test\.agentnovas\.com/);
  assert.match(workflow, /main-test\.agentnovas\.com/);
  assert.doesNotMatch(workflow, /:latest|environment:\s*production|\bssh\b/i);
  for (const action of workflow.matchAll(/uses:\s*([^\s]+)/g)) {
    assert.match(action[1], /@[a-f0-9]{40}$/, `action must be pinned: ${action[1]}`);
  }
});

test("main CI and governance files preserve manual promotion", async () => {
  const [ci, dependabot, owners, runbook] = await Promise.all([
    read(".github/workflows/strategy-research-ci.yml"),
    read(".github/dependabot.yml"),
    read(".github/CODEOWNERS"),
    read("docs/runbooks/transition-preview-promotion.md"),
  ]);

  assert.match(ci, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(ci, /quality:boundaries/);
  assert.match(ci, /quality:key-custody/);
  assert.match(ci, /pack:packages/);
  for (const action of ci.matchAll(/uses:\s*([^\s]+)/g)) {
    assert.match(action[1], /@[a-f0-9]{40}$/, `action must be pinned: ${action[1]}`);
  }
  assert.match(dependabot, /package-ecosystem:\s*"npm"/);
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/);
  assert.match(owners, /@js2728520-collab/);
  assert.match(runbook, /manual fast-forward|手动 fast-forward/i);
  assert.match(runbook, /main 不自动部署|main is never deployed automatically/i);
  assert.match(runbook, /rollback|回滚/i);
});
