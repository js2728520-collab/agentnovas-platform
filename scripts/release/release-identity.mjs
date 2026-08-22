import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function normalizeReleaseVersion(input) {
  const value = String(input ?? "").trim();
  const version = value.startsWith("v") ? value.slice(1) : value;
  if (!SEMVER.test(version)) throw new Error("Release version must be a valid SemVer value");
  return { version, versionTag: `v${version}` };
}
function git(...argumentsList) {
  return execFileSync("git", argumentsList, { encoding: "utf8" }).trim();
}

export async function releaseIdentity(input, options = {}) {
  const normalized = normalizeReleaseVersion(input);
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  if (packageJson.version !== normalized.version) {
    throw new Error(`package.json version ${packageJson.version} does not match ${normalized.versionTag}`);
  }
  const commitSha = git("rev-parse", "HEAD").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("Git commit SHA is not a full 40-character hash");
  const dirty = git("status", "--porcelain");
  if (dirty && !options.allowDirty) throw new Error("Release identity requires a clean Git worktree");
  const migrations = (await readdir(new URL("../../postgres/migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (!migrations.length) throw new Error("No production PostgreSQL migrations were found");
  return {
    ...normalized,
    commitSha,
    migrationVersion: migrations.at(-1).slice(0, 4),
    migrationFile: migrations.at(-1),
    dirty: Boolean(dirty),
  };
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const allowDirty = argumentsList.includes("--allow-dirty");
  const input = argumentsList.find((value) => !value.startsWith("--")) ?? process.env.RIVERTON_RELEASE_TAG;
  const identity = await releaseIdentity(input, { allowDirty });
  process.stdout.write(`${JSON.stringify(identity)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Release identity failed"}\n`);
    process.exitCode = 1;
  });
}
