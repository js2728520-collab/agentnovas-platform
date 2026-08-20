import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join, relative, resolve } from "node:path";

import {
  cleanupQualityDatabaseFixture,
  prepareQualityDatabaseFixture,
} from "./quality-database-fixture.mjs";
import { createQualityRunEnvironment } from "./quality-e2e-runner.mjs";
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

export async function verifyLighthouseRunEvidence(outputDirectory) {
  const root = resolve(outputDirectory);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest)
    || manifest.length !== 3
    || manifest.filter((entry) => entry?.isRepresentativeRun === true).length !== 1) {
    throw new Error("Lighthouse evidence must contain exactly three runs and one representative run");
  }
  for (const entry of manifest) {
    const reportPath = resolve(String(entry?.jsonPath ?? ""));
    const reportRelativePath = relative(root, reportPath);
    if (!reportRelativePath || reportRelativePath.startsWith("..") || resolve(root, reportRelativePath) !== reportPath) {
      throw new Error("Lighthouse report path escaped the evidence directory");
    }
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    if (finiteMetric(report?.categories?.performance?.score, "performance score") < 0.9
      || finiteMetric(report?.categories?.accessibility?.score, "accessibility score") < 1
      || finiteMetric(report?.categories?.["best-practices"]?.score, "best-practices score") < 0.95) {
      throw new Error("Lighthouse category score threshold was not met in every run");
    }
    if (finiteMetric(report?.audits?.["largest-contentful-paint"]?.numericValue, "LCP") > 2_500) {
      throw new Error("Lighthouse LCP threshold was not met in every run");
    }
    if (finiteMetric(report?.audits?.["cumulative-layout-shift"]?.numericValue, "CLS") > 0.1) {
      throw new Error("Lighthouse CLS threshold was not met in every run");
    }
    if (finiteMetric(report?.audits?.["total-blocking-time"]?.numericValue, "TBT") > 200) {
      throw new Error("Lighthouse TBT threshold was not met in every run");
    }
    const resources = report?.audits?.["resource-summary"]?.details?.items;
    if (!Array.isArray(resources)) throw new Error("Lighthouse resource summary is missing");
    const size = (type) => resources
      .filter((resource) => resource?.resourceType === type)
      .reduce((total, resource) => total + finiteMetric(resource?.transferSize, `${type} transfer size`), 0);
    if (size("script") > 200 * 1_024
      || size("stylesheet") > 50 * 1_024
      || size("image") > 200 * 1_024) {
      throw new Error("Lighthouse resource threshold was not met in every run");
    }
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
  const runtimeDirectory = join(outputDirectory, ".runtime");
  const runId = environment.QUALITY_LIGHTHOUSE_RUN_ID
    ?? `${Date.now()}_${process.pid}_${randomBytes(4).toString("hex")}`;
  const schema = qualitySchemaName(`lighthouse_${runId}`);
  const adminDatabaseUrl = environment.QUALITY_E2E_DATABASE_URL
    ?? environment.TEST_DATABASE_URL
    ?? "postgresql://127.0.0.1/postgres";
  const ports = qualityApplicationPorts(environment);
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
    await verifyLighthouseRunEvidence(outputDirectory);
    lighthousePassed = true;
    return result;
  } finally {
    let schemaCleanupComplete = false;
    let runtimeSecretsRemoved = false;
    let lhciWorkingFilesRemoved = false;
    try {
      if (proxy) await proxy.close();
    } finally {
      try {
        await rm(lhciWorkingDirectory, { recursive: true, force: true });
        lhciWorkingFilesRemoved = true;
      } finally {
        try {
          await cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema });
          schemaCleanupComplete = true;
        } finally {
          await rm(runtimeDirectory, { recursive: true, force: true });
          runtimeSecretsRemoved = true;
          await mkdir(outputDirectory, { recursive: true });
          await writeFile(join(outputDirectory, "gate-result.json"), JSON.stringify({
            passed: lighthousePassed,
            numberOfRuns: 3,
            externalWritesEnabled: false,
          }, null, 2));
          await writeFile(join(outputDirectory, "fixture-cleanup.json"), JSON.stringify({
            schema,
            startedAt: startedAt.toISOString(),
            completedAt: new Date().toISOString(),
            fixturePrepared: Boolean(fixture),
            schemaCleanupComplete,
            runtimeSecretsRemoved,
            lhciWorkingFilesRemoved,
            externalWritesEnabled: false,
          }, null, 2));
        }
      }
    }
  }
}
