import assert from "node:assert/strict";
import test from "node:test";

import { aiRequestLimit, containsPotentialSecret, normalizeAiMessage } from "../lib/ai-safety.ts";

test("rejects empty and oversized AI messages at the server boundary", () => {
  assert.throws(() => normalizeAiMessage("   "), /请输入/);
  assert.throws(() => normalizeAiMessage("x".repeat(2_001)), /2000/);
  assert.equal(normalizeAiMessage("  分析 BTC 风险  "), "分析 BTC 风险");
});

test("detects credential-shaped content without blocking ordinary security questions", () => {
  assert.equal(containsPotentialSecret("我的密码忘记了，怎么重置？"), false);
  assert.equal(containsPotentialSecret("API key: sk-proj-abcdefghijklmnopqrstuv"), true);
  assert.equal(containsPotentialSecret("password = correct-horse-battery-staple"), true);
  assert.equal(containsPotentialSecret("-----BEGIN PRIVATE KEY-----"), true);
});

test("uses explicit minute and daily request limits", () => {
  assert.deepEqual(aiRequestLimit, { perMinute: 10, perDay: 100 });
});
