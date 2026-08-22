import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("uses native Next.js commands without Cloudflare runtime dependencies", async () => {
  const packageJson = JSON.parse(await text("package.json"));

  assert.equal(packageJson.name, "agentnovas-platform");
  assert.match(packageJson.scripts.dev, /^(?:NODE_USE_ENV_PROXY=1 )?next dev\b/);
  assert.equal(packageJson.scripts.build, "next build");
  assert.match(packageJson.scripts.start, /^(?:NODE_USE_ENV_PROXY=1 )?next start\b/);
  assert.match(packageJson.scripts["worker:research"], /NODE_USE_ENV_PROXY=1/);
  assert.equal(typeof packageJson.dependencies.next, "string");

  for (const dependency of ["vinext", "wrangler", "@cloudflare/vite-plugin"]) {
    assert.equal(packageJson.dependencies?.[dependency], undefined);
    assert.equal(packageJson.devDependencies?.[dependency], undefined);
  }
});

test("requires PostgreSQL and has no Cloudflare worker fallback", async () => {
  const databaseSource = await text("db/index.ts");
  const postgresSource = await text("lib/postgres.ts");
  const runtimeSettingsSource = await text("lib/runtime-setting.ts");

  assert.doesNotMatch(databaseSource, /cloudflare:workers|D1 binding/i);
  assert.match(databaseSource, /getDeferredPostgresPool/);
  assert.doesNotMatch(databaseSource, /await getPostgresPool|process\.env\.DATABASE_URL/);
  assert.match(postgresSource, /environment\.DATABASE_URL/);
  assert.match(postgresSource, /expectedWebDatabaseRole/);
  assert.match(postgresSource, /SELECT current_user/);
  assert.doesNotMatch(runtimeSettingsSource, /cloudflare:workers/);
});

test("deferred build-time database handle remains a real Pool for Drizzle transactions", async () => {
  const [{ getDeferredPostgresPool }, { default: pg }] = await Promise.all([
    import("../lib/postgres.ts"),
    import("pg"),
  ]);
  const deferred = getDeferredPostgresPool();
  assert.equal(deferred instanceof pg.Pool, true);
  assert.equal(Object.getPrototypeOf(deferred).constructor, pg.Pool);
});

test("does not ship obsolete Cloudflare entrypoints", async () => {
  for (const path of ["vite.config.ts", "worker/index.ts", "cloudflare-runtime.d.ts", ".openai/hosting.json"]) {
    await assert.rejects(access(new URL(path, root)));
  }
});
