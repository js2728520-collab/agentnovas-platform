import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { scanTrackedRepository, secretFindingForFile } from "../scripts/quality/repository-secret-scan.mjs";

const execFileAsync = promisify(execFile);

test("secret scanner rejects tracked secret containers and private keys", () => {
  assert.equal(secretFindingForFile(".env.production", "SAFE=false"), "forbidden secret-bearing filename");
  assert.equal(secretFindingForFile("backup/customer.dump", "binary"), "forbidden secret-bearing filename");
  assert.equal(secretFindingForFile("notes.txt", ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")), "private key material");
});

test("secret scanner permits templates, migrations and redacted examples", () => {
  assert.equal(secretFindingForFile(".env.example", "API_KEY=replace-me"), null);
  assert.equal(secretFindingForFile("postgres/migrations/0001.sql", "CREATE TABLE users(id text);"), null);
  assert.equal(secretFindingForFile("docs/runbook.md", "Authorization: [REDACTED]"), null);
});

test("secret scanner detects high confidence provider tokens", () => {
  assert.equal(secretFindingForFile("config.json", `{"token":"AKIA${"A".repeat(16)}"}`), "AWS access key");
  assert.equal(secretFindingForFile("config.json", `{"token":"ghp_${"a".repeat(36)}"}`), "GitHub token");
  assert.equal(secretFindingForFile("config.json", `{"token":"sk-live-${"a".repeat(24)}"}`), "live provider token");
});

test("repository scan does not skip secret material after four MiB", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agentnovas-secret-scan-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    const token = `ghp_${"a".repeat(36)}`;
    await writeFile(join(repository, "large-export.json"), `${" ".repeat(4 * 1024 * 1024 + 32)}${token}`);
    await execFileAsync("git", ["add", "large-export.json"], { cwd: repository });
    const result = await scanTrackedRepository(repository);
    assert.deepEqual(result.findings, [{ path: "large-export.json", finding: "GitHub token" }]);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("repository scan skips index entries deleted from the working tree", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agentnovas-secret-scan-deleted-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    const deletedPath = join(repository, "retired-config.ts");
    await writeFile(deletedPath, "export const retired = true;\n");
    await execFileAsync("git", ["add", "retired-config.ts"], { cwd: repository });
    await unlink(deletedPath);

    const result = await scanTrackedRepository(repository);

    assert.equal(result.scannedFiles, 0);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("repository scan includes untracked non-ignored files before staging", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agentnovas-secret-scan-untracked-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    await writeFile(join(repository, "release-note.txt"), `token=ghp_${"b".repeat(36)}\n`);

    const result = await scanTrackedRepository(repository);

    assert.deepEqual(result.findings, [{ path: "release-note.txt", finding: "GitHub token" }]);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("repository scan skips an untracked nested repository directory without skipping regular files", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agentnovas-secret-scan-nested-repository-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    await writeFile(join(repository, "release-note.txt"), "No credentials in this release.\n");

    const nestedRepository = join(repository, "nested-worktree");
    await mkdir(nestedRepository);
    await execFileAsync("git", ["init", "-q"], { cwd: nestedRepository });
    await writeFile(join(nestedRepository, "README.md"), "Nested repository contents are independently managed.\n");

    const result = await scanTrackedRepository(repository);

    assert.equal(result.scannedFiles, 1);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("repository scan reads a symbolic link itself instead of following it outside the repository", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agentnovas-secret-scan-symlink-repository-"));
  const externalDirectory = await mkdtemp(join(tmpdir(), "agentnovas-secret-scan-symlink-target-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    const externalFile = join(externalDirectory, "external.txt");
    await writeFile(externalFile, `token=ghp_${"c".repeat(36)}\n`);
    await symlink(externalFile, join(repository, "external-reference"));

    const result = await scanTrackedRepository(repository);

    assert.equal(result.scannedFiles, 1);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(externalDirectory, { recursive: true, force: true });
  }
});
