import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("strategy create and update validate DSL and append immutable version rows", async () => {
  const [collectionRoute, itemRoute] = await Promise.all([
    readFile(new URL("../app/api/strategy-marketplace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/strategy-marketplace/[id]/route.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [collectionRoute, itemRoute]) {
    assert.match(source, /normalizeStrategyDsl/);
    assert.match(source, /insert\(strategyVersions\)/);
    assert.match(source, /specificationJson:\s*JSON\.stringify\(specification\)/);
  }
  assert.match(itemRoute, /version:\s*nextVersion/);
  assert.doesNotMatch(collectionRoute, /specificationJson:\s*JSON\.stringify\(body\.specification\s*\|\|\s*\{\}\)/);
});
