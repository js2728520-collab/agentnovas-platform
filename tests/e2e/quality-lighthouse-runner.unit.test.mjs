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
    assert.equal(
      configuration.ci.collect.startServerReadyPattern,
      String.raw`\bReady in [0-9]+(?:\.[0-9]+)?(?:ms|s)\b`,
    );
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

test("Lighthouse runner binds reports and gates the LHCI-computed representative run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-quality-lhci-evidence-"));
  const targetUrl = "http://127.0.0.1:3100/login";
  const report = ({ fcp, interactive, lcp = 2_300, fetchTime } = {}) => ({
    requestedUrl: targetUrl,
    finalUrl: targetUrl,
    fetchTime,
    lighthouseVersion: "12.6.1",
    runtimeError: null,
    categories: {
      performance: { score: 0.98 },
      accessibility: { score: 1 },
      "best-practices": { score: 1 },
    },
    audits: {
      "first-contentful-paint": { numericValue: fcp },
      interactive: { numericValue: interactive },
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
    const measurements = [
      { fcp: 900, interactive: 2_400, lcp: 2_300, fetchTime: "2026-08-21T15:31:13.241Z" },
      { fcp: 920, interactive: 2_420, lcp: 2_300, fetchTime: "2026-08-21T15:31:26.040Z" },
      { fcp: 950, interactive: 2_800, lcp: 2_501, fetchTime: "2026-08-21T15:31:37.155Z" },
    ];
    for (let index = 0; index < 3; index += 1) {
      const path = join(directory, `report-${index}.json`);
      await writeFile(path, JSON.stringify(report(measurements[index])));
      entries.push({
        url: targetUrl,
        jsonPath: path,
        isRepresentativeRun: index === 1,
        summary: { performance: 0.98, accessibility: 1, "best-practices": 1 },
      });
    }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(entries));
    await verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl });

    const tamperedMarker = entries.map((entry, index) => ({
      ...entry,
      isRepresentativeRun: index === 0,
    }));
    await writeFile(join(directory, "manifest.json"), JSON.stringify(tamperedMarker));
    await assert.rejects(
      () => verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl }),
      /representative run does not match LHCI computation/,
    );
    await writeFile(join(directory, "manifest.json"), JSON.stringify(entries));

    const duplicateRun = report({ ...measurements[2], fetchTime: measurements[0].fetchTime });
    await writeFile(entries[2].jsonPath, JSON.stringify(duplicateRun));
    await assert.rejects(
      () => verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl }),
      /three distinct run identities/,
    );
    await writeFile(entries[2].jsonPath, JSON.stringify(report(measurements[2])));

    const representativeOverBudget = report({ ...measurements[1], lcp: 2_501 });
    await writeFile(entries[1].jsonPath, JSON.stringify(representativeOverBudget));
    await assert.rejects(
      () => verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl }),
      /LCP threshold/,
    );
    await writeFile(entries[1].jsonPath, JSON.stringify(report(measurements[1])));

    const missingMetric = report(measurements[2]);
    missingMetric.audits["total-blocking-time"].numericValue = null;
    await writeFile(entries[2].jsonPath, JSON.stringify(missingMetric));
    await assert.rejects(
      () => verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl }),
      /TBT is missing/,
    );
    for (const resourceType of ["script", "stylesheet", "image"]) {
      const missingResource = report(measurements[2]);
      missingResource.audits["resource-summary"].details.items = missingResource
        .audits["resource-summary"].details.items
        .filter((resource) => resource.resourceType !== resourceType);
      await writeFile(entries[2].jsonPath, JSON.stringify(missingResource));
      await assert.rejects(
        () => verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl }),
        new RegExp(`${resourceType} resource evidence is missing`),
      );
    }

    const invalidCases = [
      ["requested URL", (value) => { value.requestedUrl = "http://127.0.0.1:3100/other"; }],
      ["manifest summary", (value) => { value.categories.performance.score = 0.97; }],
      ["runtime error", (value) => { value.runtimeError = { code: "ERRORED_DOCUMENT_REQUEST" }; }],
      ["performance score", (value) => { value.categories.performance.score = 1.1; }],
      ["script transfer size", (value) => { value.audits["resource-summary"].details.items[0].transferSize = -1; }],
      ["FCP", (value) => { delete value.audits["first-contentful-paint"]; }],
      ["Interactive", (value) => { delete value.audits.interactive; }],
    ];
    for (const [message, mutate] of invalidCases) {
      const invalid = report(measurements[2]);
      mutate(invalid);
      await writeFile(entries[2].jsonPath, JSON.stringify(invalid));
      await assert.rejects(
        () => verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl }),
        new RegExp(message, "i"),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Lighthouse representative tie uses original fetch order before LHCI manifest reordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-quality-lhci-tie-"));
  const targetUrl = "http://127.0.0.1:3000/login";
  const summary = { performance: 0.98, accessibility: 1, "best-practices": 1 };
  const report = (fetchTime) => ({
    requestedUrl: targetUrl,
    finalUrl: targetUrl,
    fetchTime,
    lighthouseVersion: "12.6.1",
    runtimeError: null,
    categories: {
      performance: { score: summary.performance },
      accessibility: { score: summary.accessibility },
      "best-practices": { score: summary["best-practices"] },
    },
    audits: {
      "first-contentful-paint": { numericValue: 920 },
      interactive: { numericValue: 2_420 },
      "largest-contentful-paint": { numericValue: 2_300 },
      "cumulative-layout-shift": { numericValue: 0 },
      "total-blocking-time": { numericValue: 10 },
      "resource-summary": { details: { items: [
        { resourceType: "script", transferSize: 100_000 },
        { resourceType: "stylesheet", transferSize: 20_000 },
        { resourceType: "image", transferSize: 50_000 },
      ] } },
    },
  });
  try {
    const originalRuns = [
      report("2026-08-21T15:31:13.241Z"),
      report("2026-08-21T15:31:26.040Z"),
      report("2026-08-21T15:31:37.155Z"),
    ];
    const manifestOrder = [originalRuns[1], originalRuns[2], originalRuns[0]];
    const manifest = [];
    for (const [index, value] of manifestOrder.entries()) {
      const jsonPath = join(directory, `report-${index}.json`);
      await writeFile(jsonPath, JSON.stringify(value));
      manifest.push({
        url: targetUrl,
        jsonPath,
        isRepresentativeRun: index === 2,
        summary,
      });
    }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await verifyLighthouseRunEvidence(directory, { expectedUrl: targetUrl });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
