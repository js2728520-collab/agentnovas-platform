import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { boundedAiHistory } from "../lib/ai-provider.ts";
import { aiConversationLimit, aiRequestLimit, containsPotentialSecret, normalizeAiMessage } from "../lib/ai-safety.ts";

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
  assert.deepEqual(aiConversationLimit, { perMinute: 10, active: 50 });
});

test("bounds provider history by both message count and total characters", () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: String(index).padStart(2, "0") + "x".repeat(998),
  }));
  const bounded = boundedAiHistory(history, 12, 5_000);

  assert.equal(bounded.length, 5);
  assert.equal(bounded.reduce((sum, message) => sum + message.content.length, 0), 5_000);
  assert.equal(bounded.at(-1).content.startsWith("19"), true);
});

test("AI JSON reader enforces a small request-body boundary before parsing", async () => {
  const source = await readFile(new URL("../lib/ai-api.ts", import.meta.url), "utf8");
  assert.match(source, /maximumBytes = 32_768/);
  assert.match(source, /REQUEST_TOO_LARGE/);
  assert.match(source, /TextEncoder/);
});
