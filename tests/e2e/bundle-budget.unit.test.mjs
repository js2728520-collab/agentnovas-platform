import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  assertWithinBundleBudget,
  measureNextInitialAssets,
} from "../../scripts/quality/next-bundle-budget.mjs";

test("bundle measurement counts unique root and route assets by compressed bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-quality-budget-"));
  try {
    await mkdir(join(directory, "static", "chunks"), { recursive: true });
    await mkdir(join(directory, "static", "css"), { recursive: true });
    await writeFile(join(directory, "build-manifest.json"), JSON.stringify({
      rootMainFiles: ["static/chunks/root.js"],
      pages: {},
    }));
    await mkdir(join(directory, "server", "app"), { recursive: true });
    const clientManifest = {
      entryJSFiles: {
        "[project]/app/layout": ["static/chunks/root.js"],
        "[project]/app/page": ["static/chunks/root.js", "static/chunks/page.js"],
      },
      entryCSSFiles: {
        "[project]/app/layout": [{ path: "static/css/layout.css", inlined: false }],
        "[project]/app/page": [{ path: "static/css/page.css", inlined: false }],
      },
    };
    await writeFile(
      join(directory, "server", "app", "page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {}; globalThis.__RSC_MANIFEST["/page"] = ${JSON.stringify(clientManifest)};`,
    );
    await writeFile(join(directory, "static/chunks/root.js"), "const root='root';".repeat(100));
    await writeFile(join(directory, "static/chunks/page.js"), "const page='page';".repeat(100));
    await writeFile(join(directory, "static/css/layout.css"), ".layout{display:grid}".repeat(100));
    await writeFile(join(directory, "static/css/page.css"), ".page{display:block}".repeat(100));

    const result = await measureNextInitialAssets(directory, "/page");
    assert.deepEqual(result.assets, [
      "static/chunks/page.js",
      "static/chunks/root.js",
      "static/css/layout.css",
      "static/css/page.css",
    ]);
    assert.ok(result.javascriptGzipBytes > 0);
    assert.ok(result.cssGzipBytes > 0);
    assert.doesNotThrow(() => assertWithinBundleBudget(result, {
      javascriptGzipBytes: result.javascriptGzipBytes,
      cssGzipBytes: result.cssGzipBytes,
    }));
    assert.throws(() => assertWithinBundleBudget(result, {
      javascriptGzipBytes: result.javascriptGzipBytes - 1,
      cssGzipBytes: result.cssGzipBytes,
    }), /JavaScript/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle measurement fails closed when Next manifests or route assets are missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentnovas-quality-budget-empty-"));
  try {
    await assert.rejects(() => measureNextInitialAssets(directory, "/page"), /manifest/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle measurement reads the deployable standalone manifest after intermediate server cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), ".next-quality-budget-"));
  try {
    const buildName = basename(directory);
    await mkdir(join(directory, "static", "chunks"), { recursive: true });
    await mkdir(join(directory, "standalone", buildName, "server", "app"), { recursive: true });
    await writeFile(join(directory, "build-manifest.json"), JSON.stringify({ rootMainFiles: [] }));
    await writeFile(
      join(directory, "standalone", buildName, "server", "app", "page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {}; globalThis.__RSC_MANIFEST["/page"] = ${JSON.stringify({
        entryJSFiles: { "[project]/app/page": ["static/chunks/page.js"] },
        entryCSSFiles: {},
      })};`,
    );
    await writeFile(join(directory, "static", "chunks", "page.js"), "export const deployed = true;");
    const result = await measureNextInitialAssets(directory, "/page");
    assert.deepEqual(result.assets, ["static/chunks/page.js"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
