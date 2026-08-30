import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the default test suite never imports ignored build output", async () => {
  const renderedSuite = await readFile(new URL("./rendered-html.test.mjs", import.meta.url), "utf8");
  const ignoredOutputPattern = new RegExp(["dist", "server", "index\\.js"].join("[/\\\\]+"));
  assert.doesNotMatch(renderedSuite, ignoredOutputPattern);
});

test("package scripts describe separate logic, app-build and runtime-smoke gates", async () => {
  const [packageJson,appBuilds] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../scripts/quality/run-app-builds.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(packageJson.scripts.pretest, /build:packages/);
  assert.match(packageJson.scripts.test, /test:all/);
  assert.match(packageJson.scripts["test:apps"], /run-app-builds/);
  assert.match(appBuilds, /\["client", "operations", "maintenance"\]/);
  assert.match(appBuilds, /`build:\$\{audience\}`/);
  assert.match(appBuilds, /\.next-\$\{audience\}.*"cache"/s);
  assert.match(appBuilds, /\.next-\$\{audience\}.*"server"/s);
  assert.match(packageJson.scripts["test:smoke"], /build:client/);
  assert.match(packageJson.scripts["test:smoke"], /smoke-next-render/);
});

test("the production smoke maps its random port to the explicit client audience", async () => {
  const smokeScript = await readFile(new URL("../scripts/smoke-next-render.mjs", import.meta.url), "utf8");

  assert.match(smokeScript, /RIVERTON_APP_AUDIENCE:\s*["']client["']/);
  assert.match(smokeScript, /RIVERTON_APP_LOCAL_PORT:\s*String\(port\)/);
  assert.match(smokeScript, /正在验证客户端会话/);
  assert.doesNotMatch(smokeScript, /交易大厅\|Trading Hall/);
});
