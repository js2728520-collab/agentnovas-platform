import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";

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
    ["agentnovas.com", ports.client],
    ["zht.agentnovas.com", ports.operations],
    ["xm.agentnovas.com", ports.maintenance],
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
    const expectedPort = allowedTargets.get(target.hostname.toLowerCase());
    if (target.protocol !== "http:"
      || !expectedPort
      || target.port !== String(expectedPort)
      || target.username
      || target.password) {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
    const headers = { ...incoming.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: expectedPort,
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
