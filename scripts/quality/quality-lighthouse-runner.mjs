import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join, relative, resolve } from "node:path";

import {
  cleanupQualityDatabaseFixture,
  prepareQualityDatabaseFixture,
} from "./quality-database-fixture.mjs";
import {
  createQualityRunEnvironment,
  finalizeQualityFixtureCleanup,
  resetQualityOutputDirectory,
} from "./quality-e2e-runner.mjs";
import {
  assertQualitySideEffectsDisabled,
  qualityApplicationPorts,
  qualitySchemaName,
} from "./quality-policy.mjs";

export async function resolveLocalLhciBinary(repositoryRoot) {
  const binary = join(repositoryRoot, "node_modules", ".bin", "lhci");
  try {
    await access(binary);
  } catch {
    throw new Error("@lhci/cli is not installed locally; add the approved dev dependency and run npm ci");
  }
  return binary;
}

export async function resetQualityLighthouseOutput(options) {
  await resetQualityOutputDirectory(options);
}

async function assertLhciDirectoryAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite an existing LHCI working directory: ${path}`);
}

function listenOnLoopback(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen(server.address());
    });
  });
}

function rejectProxySocket(socket, statusLine) {
  socket.on("error", () => {});
  socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
}

export async function startQualityLighthouseProxy(ports) {
  const allowedTargets = new Map([
    ["agentnovas.com", { port: ports.client, upstreamHost: "agentnovas.com" }],
    ["zht.agentnovas.com", { port: ports.operations, upstreamHost: "zht.agentnovas.com" }],
    ["xm.agentnovas.com", { port: ports.maintenance, upstreamHost: "xm.agentnovas.com" }],
    ["127.0.0.1", { port: ports.client, upstreamHost: "agentnovas.com" }],
  ]);
  const server = createServer((incoming, response) => {
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      response.writeHead(405, { connection: "close" });
      response.end();
      return;
    }
    let target;
    try {
      target = new URL(incoming.url ?? "");
    } catch {
      response.writeHead(400, { connection: "close" });
      response.end();
      return;
    }
    const allowedTarget = allowedTargets.get(target.hostname.toLowerCase());
    if (target.protocol !== "http:"
      || !allowedTarget
      || target.port !== String(allowedTarget.port)
      || target.username
      || target.password) {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
    const headers = { ...incoming.headers, host: `${allowedTarget.upstreamHost}:${allowedTarget.port}` };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: allowedTarget.port,
      method: incoming.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502, { connection: "close" });
      response.end();
    });
    incoming.once("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connect", (_request, socket) => {
    rejectProxySocket(socket, "403 Forbidden");
  });
  server.on("clientError", (_error, socket) => {
    rejectProxySocket(socket, "400 Bad Request");
  });
  const address = await listenOnLoopback(server);
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Lighthouse proxy failed to bind a loopback TCP port");
  }
  return {
    port: address.port,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function spawnLhci(binary, options) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(binary, ["autorun", "--config=scripts/quality/lighthouserc.cjs"], {
      cwd: options.repositoryRoot,
      env: options.environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
}

function finiteMetric(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Lighthouse ${label} is missing or invalid`);
  }
  return value;
}

function boundedMetric(value, label, { minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  const metric = finiteMetric(value, label);
  if (metric < minimum || metric > maximum) {
    throw new Error(`Lighthouse ${label} is outside the valid range`);
  }
  return metric;
}

function validateFetchTime(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error("Lighthouse fetch time is missing or invalid");
  }
  return timestamp;
}

function validateLighthouseVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Lighthouse version is missing or invalid");
  }
  return value;
}

function representativeReportIndex(reports) {
  // Keep this in lockstep with @lhci/utils 0.15.1 computeRepresentativeRuns:
  // https://github.com/GoogleChrome/lighthouse-ci/blob/v0.15.1/packages/utils/src/representative-runs.js
  // LHCI computes from collection order, then moves the selected report to the
  // end of filesystem manifests. Unique fetch times reconstruct collection order.
  const collectionOrder = reports
    .slice()
    .sort((left, right) => left.fetchTimestamp - right.fetchTimestamp);
  const median = (key) => collectionOrder
    .map((report) => report[key])
    .sort((left, right) => left - right)[Math.floor(collectionOrder.length / 2)];
  const medianFcp = median("fcp");
  const medianInteractive = median("interactive");
  return collectionOrder
    .map((report) => ({
      index: report.index,
      distance: ((medianFcp - report.fcp) ** 2) + ((medianInteractive - report.interactive) ** 2),
    }))
    .sort((left, right) => left.distance - right.distance)[0].index;
}

function validateAuditTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error("Lighthouse expected audit target is missing or invalid");
  }
  const port = Number(target.port);
  if (target.protocol !== "http:"
    || target.hostname !== "127.0.0.1"
    || !Number.isInteger(port)
    || port < 3_000
    || port > 65_500
    || target.pathname !== "/login"
    || target.search
    || target.hash
    || target.username
    || target.password) {
    throw new Error("Lighthouse expected audit target is outside the loopback login policy");
  }
  return target.href;
}

export async function verifyLighthouseRunEvidence(
  outputDirectory,
  { expectedUrl = "http://127.0.0.1:3000/login" } = {},
) {
  const root = resolve(outputDirectory);
  const auditTargetUrl = validateAuditTarget(expectedUrl);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest)
    || manifest.length !== 3
    || manifest.filter((entry) => entry?.isRepresentativeRun === true).length !== 1) {
    throw new Error("Lighthouse evidence must contain exactly three runs and one representative run");
  }
  const reportPaths = [];
  const reports = [];
  let lighthouseVersion;
  for (const [index, entry] of manifest.entries()) {
    if (entry?.url !== auditTargetUrl) {
      throw new Error("Lighthouse manifest URL does not match the expected audit target");
    }
    const reportPath = resolve(String(entry?.jsonPath ?? ""));
    reportPaths.push(reportPath);
    const reportRelativePath = relative(root, reportPath);
    if (!reportRelativePath || reportRelativePath.startsWith("..") || resolve(root, reportRelativePath) !== reportPath) {
      throw new Error("Lighthouse report path escaped the evidence directory");
    }
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    if (report?.requestedUrl !== entry.url || report.requestedUrl !== auditTargetUrl) {
      throw new Error("Lighthouse requested URL does not match the manifest and expected audit target");
    }
    if (report?.finalUrl !== auditTargetUrl) {
      throw new Error("Lighthouse final URL does not match the expected audit target");
    }
    const fetchTimestamp = validateFetchTime(report?.fetchTime);
    const reportVersion = validateLighthouseVersion(report?.lighthouseVersion);
    if (lighthouseVersion && lighthouseVersion !== reportVersion) {
      throw new Error("Lighthouse reports were produced by different Lighthouse versions");
    }
    lighthouseVersion = reportVersion;
    if (report?.runtimeError != null) {
      throw new Error("Lighthouse report contains a runtime error");
    }
    const metrics = {
      performance: boundedMetric(report?.categories?.performance?.score, "performance score", { maximum: 1 }),
      accessibility: boundedMetric(report?.categories?.accessibility?.score, "accessibility score", { maximum: 1 }),
      bestPractices: boundedMetric(report?.categories?.["best-practices"]?.score, "best-practices score", { maximum: 1 }),
      fcp: boundedMetric(report?.audits?.["first-contentful-paint"]?.numericValue, "FCP"),
      interactive: boundedMetric(report?.audits?.interactive?.numericValue, "Interactive"),
      lcp: boundedMetric(report?.audits?.["largest-contentful-paint"]?.numericValue, "LCP"),
      cls: boundedMetric(report?.audits?.["cumulative-layout-shift"]?.numericValue, "CLS"),
      tbt: boundedMetric(report?.audits?.["total-blocking-time"]?.numericValue, "TBT"),
    };
    const categorySummary = {
      performance: metrics.performance,
      accessibility: metrics.accessibility,
      "best-practices": metrics.bestPractices,
    };
    if (!entry?.summary
      || Object.keys(entry.summary).sort().join(",") !== Object.keys(categorySummary).sort().join(",")
      || Object.entries(categorySummary).some(([key, value]) => entry.summary[key] !== value)) {
      throw new Error("Lighthouse manifest summary does not match the report categories");
    }
    const resources = report?.audits?.["resource-summary"]?.details?.items;
    if (!Array.isArray(resources)) throw new Error("Lighthouse resource summary is missing");
    const size = (type) => {
      const matching = resources.filter((resource) => resource?.resourceType === type);
      if (matching.length === 0) throw new Error(`Lighthouse ${type} resource evidence is missing`);
      return matching.reduce(
        (total, resource) => total + boundedMetric(resource?.transferSize, `${type} transfer size`),
        0,
      );
    };
    metrics.scriptBytes = size("script");
    metrics.stylesheetBytes = size("stylesheet");
    metrics.imageBytes = size("image");
    reports.push({ index, fetchTime: report.fetchTime, fetchTimestamp, ...metrics });
  }
  if (new Set(reportPaths).size !== 3) {
    throw new Error("Lighthouse evidence must contain three distinct JSON reports");
  }
  if (new Set(reports.map((report) => report.fetchTime)).size !== 3) {
    throw new Error("Lighthouse evidence must contain three distinct run identities");
  }
  const computedRepresentativeIndex = representativeReportIndex(reports);
  const markedRepresentativeIndex = manifest.findIndex((entry) => entry.isRepresentativeRun === true);
  if (markedRepresentativeIndex !== computedRepresentativeIndex) {
    throw new Error("Lighthouse representative run does not match LHCI computation");
  }
  const representativeMetrics = reports[computedRepresentativeIndex];
  if (representativeMetrics.performance < 0.9
    || representativeMetrics.accessibility < 1
    || representativeMetrics.bestPractices < 0.95) {
    throw new Error("Lighthouse category score threshold was not met in the representative run");
  }
  if (representativeMetrics.lcp > 2_500) {
    throw new Error("Lighthouse LCP threshold was not met in the representative run");
  }
  if (representativeMetrics.cls > 0.1) {
    throw new Error("Lighthouse CLS threshold was not met in the representative run");
  }
  if (representativeMetrics.tbt > 200) {
    throw new Error("Lighthouse TBT threshold was not met in the representative run");
  }
  if (representativeMetrics.scriptBytes > 200 * 1_024
    || representativeMetrics.stylesheetBytes > 50 * 1_024
    || representativeMetrics.imageBytes > 200 * 1_024) {
    throw new Error("Lighthouse resource threshold was not met in the representative run");
  }
}

export async function runQualityLighthouse({
  repositoryRoot = process.cwd(),
  environment = process.env,
} = {}) {
  assertQualitySideEffectsDisabled(environment);
  const binary = await resolveLocalLhciBinary(repositoryRoot);
  const outputDirectory = resolve(
    repositoryRoot,
    environment.QUALITY_LIGHTHOUSE_OUTPUT_DIR ?? "outputs/quality-lighthouse",
  );
  const lhciWorkingDirectory = resolve(repositoryRoot, ".lighthouseci");
  await assertLhciDirectoryAbsent(lhciWorkingDirectory);
  await resetQualityLighthouseOutput({ repositoryRoot, outputDirectory });
  const runtimeDirectory = join(outputDirectory, ".runtime");
  const runId = environment.QUALITY_LIGHTHOUSE_RUN_ID
    ?? `${Date.now()}_${process.pid}_${randomBytes(4).toString("hex")}`;
  const schema = qualitySchemaName(`lighthouse_${runId}`);
  const adminDatabaseUrl = environment.QUALITY_E2E_DATABASE_URL
    ?? environment.TEST_DATABASE_URL
    ?? "postgresql://127.0.0.1/postgres";
  const ports = qualityApplicationPorts(environment);
  const auditTargetUrl = `http://127.0.0.1:${ports.client}/login`;
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  let fixture;
  let proxy;
  let lighthousePassed = false;
  const startedAt = new Date();
  try {
    fixture = await prepareQualityDatabaseFixture({
      adminDatabaseUrl,
      schema,
      outputDirectory: runtimeDirectory,
      baseUrls: {
        client: `http://127.0.0.1:${ports.client}`,
        operations: `http://127.0.0.1:${ports.operations}`,
        maintenance: `http://127.0.0.1:${ports.maintenance}`,
      },
    });
    const childEnvironment = createQualityRunEnvironment({
      baseEnvironment: environment,
      applicationDatabaseUrl: fixture.applicationDatabaseUrl,
      outputDirectory,
      runtimeDirectory,
      schema,
    });
    childEnvironment.QUALITY_LIGHTHOUSE_OUTPUT_DIR = outputDirectory;
    proxy = await startQualityLighthouseProxy(ports);
    childEnvironment.QUALITY_LIGHTHOUSE_PROXY_PORT = String(proxy.port);
    const result = await spawnLhci(binary, { repositoryRoot, environment: childEnvironment });
    if (result.code !== 0) {
      throw new Error(`Lighthouse quality run failed with exit code ${result.code}${result.signal ? ` (${result.signal})` : ""}`);
    }
    await verifyLighthouseRunEvidence(outputDirectory, {
      expectedUrl: auditTargetUrl,
    });
    lighthousePassed = true;
    return result;
  } finally {
    let lhciWorkingFilesRemoved = false;
    try {
      if (proxy) await proxy.close();
    } finally {
      try {
        await rm(lhciWorkingDirectory, { recursive: true, force: true });
        lhciWorkingFilesRemoved = true;
      } finally {
        await finalizeQualityFixtureCleanup({
          outputDirectory,
          runtimeDirectory,
          schema,
          startedAt,
          fixturePrepared: Boolean(fixture),
          gateResult: {
            passed: lighthousePassed,
            numberOfRuns: 3,
            externalWritesEnabled: false,
            auditTargetUrl,
          },
          cleanupSchema: () => cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema }),
          cleanupEvidence: {
            lhciWorkingFilesRemoved,
          },
        });
      }
    }
  }
}
