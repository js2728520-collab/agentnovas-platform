import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("strategy create and update validate DSL and append immutable version rows", async () => {
  const [collectionRoute, itemRoute, conversationService, draftService] = await Promise.all([
    readFile(new URL("../app/api/strategy-marketplace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/strategy-marketplace/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-conversations.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/strategy-drafts.ts", import.meta.url), "utf8"),
  ]);

  assert.match(collectionRoute, /normalizeResearchStrategyDsl/);
  assert.match(collectionRoute, /createStrategyDraft/);
  assert.match(collectionRoute, /const specificationJson = JSON\.stringify\(specification\)/);
  assert.match(collectionRoute, /resolveStrategyVersionSource/);
  assert.match(draftService, /normalizeResearchStrategyDsl/);
  assert.match(draftService, /insert\(strategyVersions\)/);
  assert.match(draftService, /const specificationJson = JSON\.stringify\(specification\)/);
  assert.match(draftService, /specificationJson,/);
  assert.match(itemRoute, /normalizeResearchStrategyDsl/);
  assert.match(itemRoute, /insert\(strategyVersions\)/);
  assert.match(itemRoute, /const specificationJson = JSON\.stringify\(specification\)/);
  assert.match(itemRoute, /resolveStrategyVersionSource/);
  assert.doesNotMatch(collectionRoute, /body\.generationMode/);
  assert.doesNotMatch(itemRoute, /body\.generationMode/);
  assert.match(itemRoute, /version:\s*nextVersion/);
  assert.doesNotMatch(collectionRoute, /specificationJson:\s*JSON\.stringify\(body\.specification\s*\|\|\s*\{\}\)/);
  assert.match(conversationService, /specificationHash = await sha256/);
  assert.match(conversationService, /GENERATION_MISMATCH/);
});
