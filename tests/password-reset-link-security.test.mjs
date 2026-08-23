import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("password reset reads bearer tokens only from a hydration-safe URL fragment", async () => {
  const page = await readFile(new URL("../app/reset-password/page.tsx", import.meta.url), "utf8");
  assert.match(page, /useSyncExternalStore/);
  assert.match(page, /window\.location\.hash/);
  assert.match(page, /replace\(\/\^#\//);
  assert.match(page, /get\("token"\)/);
  assert.match(page, /getServerSnapshot/);
  assert.doesNotMatch(page, /window\.location\.search/);
});
