import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the default test suite never imports ignored build output", async () => {
  const renderedSuite = await readFile(new URL("./rendered-html.test.mjs", import.meta.url), "utf8");
  const ignoredOutputPattern = new RegExp(["dist", "server", "index\\.js"].join("[/\\\\]+"));
  assert.doesNotMatch(renderedSuite, ignoredOutputPattern);
});

test("package scripts describe separate logic, app-build and runtime-smoke gates", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /test:all/);
  assert.match(packageJson.scripts["test:apps"], /build:client/);
  assert.match(packageJson.scripts["test:smoke"], /build:client/);
  assert.match(packageJson.scripts["test:smoke"], /smoke-next-render/);
});
