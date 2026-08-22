import assert from "node:assert/strict";
import test from "node:test";

import { researchPromptRoles, resolveResearchPrompt } from "../lib/research-prompt-registry.ts";

test("publishes a versioned, hashed prompt contract for every research LLM role", async () => {
  assert.deepEqual(researchPromptRoles, [
    "requirements", "market_regime", "proposal_a", "proposal_b",
    "adversarial_review", "risk_review", "report",
  ]);
  const prompts = await Promise.all(researchPromptRoles.map(resolveResearchPrompt));
  assert.equal(new Set(prompts.map(prompt => prompt.role)).size, 7);
  assert.equal(new Set(prompts.map(prompt => prompt.hash)).size, 7);
  for (const prompt of prompts) {
    assert.match(prompt.version, /^\d+\.\d+\.\d+$/);
    assert.match(prompt.hash, /^[a-f0-9]{64}$/);
    assert.ok(prompt.system.includes("结论"));
    assert.ok(prompt.system.includes("证据引用"));
    assert.ok(prompt.system.includes("失效条件"));
    assert.ok(prompt.system.includes("异议"));
    assert.ok(prompt.system.includes("下一步"));
    assert.ok(prompt.system.includes("不输出隐藏推理"));
  }
});

test("prompt hashes are stable for the same registry version", async () => {
  const first = await resolveResearchPrompt("proposal_a");
  const second = await resolveResearchPrompt("proposal_a");
  assert.deepEqual(first, second);
  assert.ok(first.system.includes("channel_breakout"));
  assert.ok(first.system.includes("不得参考另一提案 Agent"));
});
