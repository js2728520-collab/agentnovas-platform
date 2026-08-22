import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  browserResourceBudget,
  nextBuildAssetPath,
} from "../../scripts/quality/browser-resource-budget.mjs";

test("browser budget measures gzip for the exact loaded Next assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentnovas-browser-budget-"));
  const staticRoot = join(root, ".next-client", "static", "chunks");
  try {
    await mkdir(staticRoot, { recursive: true });
    const script = "export const fixture = 'browser-loaded';".repeat(100);
    const style = ".fixture{color:#fff}".repeat(100);
    await writeFile(join(staticRoot, "fixture.js"), script);
    await writeFile(join(staticRoot, "fixture.css"), style);
    const budget = await browserResourceBudget(root, [
      { name: "https://agentnovas.com:3100/_next/static/chunks/fixture.js", initiatorType: "script", encodedBodySize: 9999, transferSize: 9999 },
      { name: "https://agentnovas.com:3100/_next/static/chunks/fixture.css", initiatorType: "link", encodedBodySize: 9999, transferSize: 9999 },
      { name: "https://agentnovas.com:3100/hero.webp", initiatorType: "img", encodedBodySize: 1234, transferSize: 1300 },
    ]);
    assert.deepEqual(budget, {
      scripts: gzipSync(script).byteLength,
      styles: gzipSync(style).byteLength,
      largestImage: 1234,
      scriptAssets: 1,
      styleAssets: 1,
    });
    assert.throws(
      () => nextBuildAssetPath(root, "https://agentnovas.com:3100/_next/static/../server.js"),
      /static asset|Unsafe/i,
    );
    assert.throws(
      () => nextBuildAssetPath(root, "https://api.binance.com/_next/static/chunks/fixture.js"),
      /static assets/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
