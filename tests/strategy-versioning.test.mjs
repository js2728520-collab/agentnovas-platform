import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("strategy create and update validate DSL and append immutable version rows", async () => {
  const [collectionRoute, itemRoute, conversationService] = await Promise.all([
    readFile(new URL("../app/api/strategy-marketplace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/strategy-marketplace/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-conversations.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [collectionRoute, itemRoute]) {
    assert.match(source, /normalizeStrategyDsl/);
    assert.match(source, /insert\(strategyVersions\)/);
    assert.match(source, /const specificationJson = JSON\.stringify\(specification\)/);
    assert.match(source, /specificationJson,/);
    assert.match(source, /resolveStrategyVersionSource/);
    assert.doesNotMatch(source, /body\.generationMode/);
  }
  assert.match(itemRoute, /version:\s*nextVersion/);
  assert.doesNotMatch(collectionRoute, /specificationJson:\s*JSON\.stringify\(body\.specification\s*\|\|\s*\{\}\)/);
  assert.match(conversationService, /specificationHash = await sha256/);
  assert.match(conversationService, /GENERATION_MISMATCH/);
});
