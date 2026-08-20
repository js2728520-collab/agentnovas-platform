import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isAllowedQualityNetworkUrl } from "./quality-policy.mjs";
import { verifyLighthouseRunEvidence } from "./quality-lighthouse-runner.mjs";

const SECRET_MATERIAL = /(?:rc_(?:client|ops|maint)_session=|an_session=|qe2e_token_|Qe2e!|\bBearer\s+[A-Za-z0-9._~+/-]+|"(?:password|secret|apiKey)"\s*:)/i;
const TEXT_EVIDENCE_EXTENSIONS = new Set([".html", ".json", ".log", ".txt", ".xml"]);
const OPAQUE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

async function json(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Missing or malformed ${label} evidence: ${path}`, { cause: error });
  }
}

async function assertEvidenceTreeSafe(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Evidence may not contain symbolic links: ${path}`);
      if (entry.isDirectory()) {
        if (entry.name === ".runtime") throw new Error(`Retained runtime secret directory: ${path}`);
        await visit(path);
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      if (OPAQUE_IMAGE_EXTENSIONS.has(extension)) {
        throw new Error(`Binary image evidence cannot be secret-scanned: ${path}`);
      }
      if (TEXT_EVIDENCE_EXTENSIONS.has(extension)) {
        const text = await readFile(path, "utf8");
        if (SECRET_MATERIAL.test(text)) throw new Error(`Evidence contains secret-like material: ${path}`);
      }
    }
  }
  await visit(root);
}

async function evidenceFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== "release-evidence.json") files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

async function artifact(root, path) {
  const body = await readFile(path);
  const text = body.toString("utf8");
  if (SECRET_MATERIAL.test(text)) throw new Error(`Evidence contains secret-like material: ${path}`);
  return {
    path: relative(root, path),
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function assertCleanup(value, label) {
  if (value?.schemaCleanupComplete !== true
    || value?.runtimeSecretsRemoved !== true
    || !Array.isArray(value?.cleanupFailures)
    || value.cleanupFailures.length !== 0
    || value?.externalWritesEnabled !== false) {
    throw new Error(`${label} cleanup evidence is incomplete or unsafe`);
  }
}

function junitSummary(xml) {
  const root = xml.match(/<testsuites\b([^>]*)>/i)?.[1] ?? "";
  const count = (name) => {
    const match = root.match(new RegExp(`\\b${name}="(\\d+)"`, "i"));
    return match ? Number(match[1]) : Number.NaN;
  };
  return {
    tests: count("tests"),
    failures: count("failures"),
    skipped: count("skipped"),
    errors: count("errors"),
  };
}

export async function verifyQualityReleaseEvidence(value) {
  const root = resolve(value);
  await lstat(root);
  await assertEvidenceTreeSafe(root);
  await verifyLighthouseRunEvidence(join(root, "quality-lighthouse"));
  const paths = {
    e2eCleanup: join(root, "quality-e2e", "fixture-cleanup.json"),
    e2eGate: join(root, "quality-e2e", "gate-result.json"),
    e2eResults: join(root, "quality-e2e", "results.xml"),
    bundle: join(root, "quality-bundle", "report.json"),
    lighthouse: join(root, "quality-lighthouse", "manifest.json"),
    lighthouseGate: join(root, "quality-lighthouse", "gate-result.json"),
    lighthouseCleanup: join(root, "quality-lighthouse", "fixture-cleanup.json"),
  };
  const [e2eCleanup, e2eGate, e2eXml, bundle, lighthouse, lighthouseGate, lighthouseCleanup] = await Promise.all([
    json(paths.e2eCleanup, "E2E cleanup"),
    json(paths.e2eGate, "E2E gate"),
    readFile(paths.e2eResults, "utf8"),
    json(paths.bundle, "bundle"),
    json(paths.lighthouse, "Lighthouse"),
    json(paths.lighthouseGate, "Lighthouse gate"),
    json(paths.lighthouseCleanup, "Lighthouse cleanup"),
  ]);
  assertCleanup(e2eCleanup, "E2E");
  assertCleanup(lighthouseCleanup, "Lighthouse");
  if (e2eGate?.passed !== true
    || e2eGate?.expectedTests !== 8
    || e2eGate?.externalWritesEnabled !== false) {
    throw new Error("E2E gate did not pass the complete side-effect-safe suite");
  }
  if (lighthouseCleanup.lhciWorkingFilesRemoved !== true) {
    throw new Error("Lighthouse working files were not removed");
  }
  if (lighthouseGate?.passed !== true
    || lighthouseGate?.numberOfRuns !== 3
    || lighthouseGate?.externalWritesEnabled !== false) {
    throw new Error("Lighthouse gate did not pass three side-effect-safe runs");
  }
  const e2eSummary = junitSummary(e2eXml);
  if (e2eSummary.tests !== 8
    || e2eSummary.failures !== 0
    || e2eSummary.skipped !== 0
    || e2eSummary.errors !== 0
    || /<(?:failure|error|skipped)(?:\s|>)/i.test(e2eXml)) {
    throw new Error("E2E evidence is not one complete passing run");
  }
  const applications = Array.isArray(bundle?.applications) ? bundle.applications : [];
  const expectedApplications = ["client", "maintenance", "operations"];
  const passedApplications = applications
    .filter((entry) => entry?.passed === true)
    .map((entry) => String(entry.name))
    .sort();
  if (JSON.stringify(passedApplications) !== JSON.stringify(expectedApplications)) {
    throw new Error("Bundle evidence does not contain three passing applications");
  }
  if (!Array.isArray(lighthouse) || lighthouse.length !== 3
    || lighthouse.filter((entry) => entry?.isRepresentativeRun === true).length !== 1
    || lighthouse.some((entry) => !isAllowedQualityNetworkUrl(String(entry?.url ?? "")))) {
    throw new Error("Lighthouse evidence is not three allowed-host runs with one representative");
  }
  const artifacts = await Promise.all((await evidenceFiles(root)).map((path) => artifact(root, path)));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    externalWritesEnabled: false,
    gates: { e2e: "passed", bundle: "passed", lighthouse: "passed" },
    artifacts,
  };
}

export async function writeQualityReleaseEvidence(root) {
  const manifest = await verifyQualityReleaseEvidence(root);
  await writeFile(join(resolve(root), "release-evidence.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(process.cwd(), process.env.QUALITY_OUTPUT_ROOT ?? "outputs");
  await writeQualityReleaseEvidence(root);
  process.stdout.write(`Quality release evidence verified: ${join(root, "release-evidence.json")}\n`);
}
