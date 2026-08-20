import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resetQualityLighthouseOutput,
  resolveLocalLhciBinary,
  startQualityLighthouseProxy,
  verifyLighthouseRunEvidence,
} from "../../scripts/quality/quality-lighthouse-runner.mjs";

const require = createRequire(import.meta.url);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function proxyRequest(proxyPort, target, method = "GET") {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port: proxyPort,
      method,
      path: target,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function proxyConnect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1");
    const chunks = [];
    socket.once("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("connect", () => socket.end(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  });
}

test("Lighthouse runner resolves only an installed local LHCI binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-quality-lhci-"));
  try {
    await assert.rejects(() => resolveLocalLhciBinary(directory), /@lhci\/cli/);
    const binDirectory = join(directory, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    const binary = join(binDirectory, "lhci");
    await writeFile(binary, "fixture");
    assert.equal(await resolveLocalLhciBinary(directory), binary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Lighthouse configuration uses the runner proxy and valid resource size assertions", () => {
  const previousProxyPort = process.env.QUALITY_LIGHTHOUSE_PROXY_PORT;
  const previousPortOffset = process.env.QUALITY_E2E_PORT_OFFSET;
  process.env.QUALITY_LIGHTHOUSE_PROXY_PORT = "31337";
  process.env.QUALITY_E2E_PORT_OFFSET = "100";
  try {
    const configuration = require("../../scripts/quality/lighthouserc.cjs");
    assert.match(configuration.ci.collect.startServerCommand, /next start -H 127\.0\.0\.1 -p 3100$/);
    assert.deepEqual(configuration.ci.collect.url, ["http://127.0.0.1:3100/login"]);
    assert.match(configuration.ci.collect.settings.chromeFlags, /--proxy-server=http:\/\/127\.0\.0\.1:31337/);
    assert.match(configuration.ci.collect.settings.chromeFlags, /--proxy-bypass-list=<-loopback>/);
    assert.equal(configuration.ci.collect.settings.chromeFlags.includes("host-resolver"), false);
    assert.equal(configuration.ci.collect.numberOfRuns, 3);
    assert.deepEqual(configuration.ci.assert.assertions["resource-summary:script:size"], ["error", { maxNumericValue: 200 * 1024 }]);
    assert.deepEqual(configuration.ci.assert.assertions["resource-summary:stylesheet:size"], ["error", { maxNumericValue: 50 * 1024 }]);
    assert.deepEqual(configuration.ci.assert.assertions["resource-summary:image:size"], ["error", { maxNumericValue: 200 * 1024 }]);
  } finally {
    if (previousProxyPort === undefined) delete process.env.QUALITY_LIGHTHOUSE_PROXY_PORT;
    else process.env.QUALITY_LIGHTHOUSE_PROXY_PORT = previousProxyPort;
    if (previousPortOffset === undefined) delete process.env.QUALITY_E2E_PORT_OFFSET;
    else process.env.QUALITY_E2E_PORT_OFFSET = previousPortOffset;
  }
});

test("Lighthouse runner removes prior-run output before collecting fresh evidence", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "agentnovas-quality-lhci-reset-"));
  const outputDirectory = join(repositoryRoot, "outputs", "quality-lighthouse");
  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, "stale-report.json"), "stale");
    await writeFile(join(outputDirectory, "manifest.json"), "stale");
    await resetQualityLighthouseOutput({ repositoryRoot, outputDirectory });
    await assert.rejects(() => access(join(outputDirectory, "stale-report.json")), /ENOENT/);
    await assert.rejects(() => access(join(outputDirectory, "manifest.json")), /ENOENT/);
    assert.ok((await access(outputDirectory)) === undefined);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Lighthouse proxy forwards only read-only quality traffic to loopback", async () => {
  const upstream = createServer((incoming, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${incoming.method} ${incoming.headers.host} ${incoming.url}`);
  });
  const address = await listen(upstream);
  const proxy = await startQualityLighthouseProxy({
    client: address.port,
    operations: address.port,
    maintenance: address.port,
  });
  try {
    const allowed = await proxyRequest(proxy.port, `http://agentnovas.com:${address.port}/login?quality=1`);
    assert.deepEqual(allowed, {
      status: 200,
      body: `GET agentnovas.com:${address.port} /login?quality=1`,
    });
    const localAudit = await proxyRequest(proxy.port, `http://127.0.0.1:${address.port}/login?quality=1`);
    assert.deepEqual(localAudit, {
      status: 200,
      body: `GET agentnovas.com:${address.port} /login?quality=1`,
    });
    assert.equal((await proxyRequest(proxy.port, "http://evil.invalid/", "GET")).status, 403);
    assert.equal((await proxyRequest(proxy.port, `http://agentnovas.com:${address.port}/login`, "POST")).status, 405);
    assert.match(await proxyConnect(proxy.port, "evil.invalid:443"), /^HTTP\/1\.1 403 Forbidden/);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("Lighthouse runner independently enforces every measured threshold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-quality-lhci-evidence-"));
  const report = (lcp) => ({
    categories: {
      performance: { score: 0.98 },
      accessibility: { score: 1 },
      "best-practices": { score: 1 },
    },
    audits: {
      "largest-contentful-paint": { numericValue: lcp },
      "cumulative-layout-shift": { numericValue: 0 },
      "total-blocking-time": { numericValue: 4 },
      "resource-summary": { details: { items: [
        { resourceType: "script", transferSize: 180_000 },
        { resourceType: "stylesheet", transferSize: 40_000 },
        { resourceType: "image", transferSize: 100_000 },
      ] } },
    },
  });
  try {
    const entries = [];
    for (let index = 0; index < 3; index += 1) {
      const path = join(directory, `report-${index}.json`);
      await writeFile(path, JSON.stringify(report(index === 2 ? 2_500 : 2_300)));
      entries.push({ url: "http://127.0.0.1:3100/login", jsonPath: path, isRepresentativeRun: index === 1 });
    }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(entries));
    await verifyLighthouseRunEvidence(directory);
    await writeFile(entries[2].jsonPath, JSON.stringify(report(2_501)));
    await assert.rejects(() => verifyLighthouseRunEvidence(directory), /LCP threshold/);
    const missingMetric = report(2_300);
    missingMetric.audits["total-blocking-time"].numericValue = null;
    await writeFile(entries[2].jsonPath, JSON.stringify(missingMetric));
    await assert.rejects(() => verifyLighthouseRunEvidence(directory), /TBT is missing/);
    for (const resourceType of ["script", "stylesheet", "image"]) {
      const missingResource = report(2_300);
      missingResource.audits["resource-summary"].details.items = missingResource
        .audits["resource-summary"].details.items
        .filter((resource) => resource.resourceType !== resourceType);
      await writeFile(entries[2].jsonPath, JSON.stringify(missingResource));
      await assert.rejects(
        () => verifyLighthouseRunEvidence(directory),
        new RegExp(`${resourceType} resource evidence is missing`),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
