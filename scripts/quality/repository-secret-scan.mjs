#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const forbiddenExtensions = new Set([".key", ".pem", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db", ".dump", ".bak"]);
const forbiddenBackupSuffixes = [".sql.gz", ".tar.gz", ".pgdump"];

export function secretFindingForFile(path, contents) {
  const name = basename(path).toLowerCase();
  const lowerPath = path.toLowerCase();
  if ((name === ".env" || (name.startsWith(".env.") && name !== ".env.example"))
    || forbiddenExtensions.has(extname(name))
    || forbiddenBackupSuffixes.some((suffix) => lowerPath.endsWith(suffix))) {
    return "forbidden secret-bearing filename";
  }
  // Match complete PEM material rather than documentation or source code that merely
  // handles a PEM boundary. A real PEM has matching labels and a substantial base64 body.
  if (/-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]{64,}\r?\n-----END \1-----/.test(contents)) {
    return "private key material";
  }
  if (/\bAKIA[A-Z0-9]{16}\b/.test(contents)) return "AWS access key";
  if (/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/.test(contents)) return "GitHub token";
  if (/\bsk-(?:live|proj)-[A-Za-z0-9_-]{20,}\b/.test(contents)) return "live provider token";
  if (/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(contents)) return "Slack token";
  return null;
}

export async function scanTrackedRepository(repositoryRoot = process.cwd()) {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  const paths = stdout.toString("utf8").split("\0").filter(Boolean);
  const findings = [];
  let scannedFiles = 0;
  for (const path of paths) {
    let body;
    try {
      const candidatePath = join(repositoryRoot, path);
      const metadata = await lstat(candidatePath);
      if (metadata.isDirectory()) continue;
      if (metadata.isSymbolicLink()) {
        body = Buffer.from(await readlink(candidatePath), "utf8");
      } else {
        if (!metadata.isFile()) continue;
        body = await readFile(candidatePath);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && (error.code === "ENOENT" || error.code === "EISDIR")) continue;
      throw error;
    }
    scannedFiles += 1;
    const finding = secretFindingForFile(path, body.toString("utf8"));
    if (finding) findings.push({ path, finding });
  }
  return { scannedFiles, findings };
}

if (process.argv[1]?.endsWith("repository-secret-scan.mjs")) {
  const result = await scanTrackedRepository();
  if (result.findings.length) {
    for (const finding of result.findings) process.stderr.write(`${finding.path}: ${finding.finding}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Repository secret scan passed: ${result.scannedFiles} tracked or untracked candidate files\n`);
  }
}
