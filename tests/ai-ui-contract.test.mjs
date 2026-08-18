import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("agent page uses persistent server conversations and streamed messages", async () => {
  const [page, chat] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/agent-chat.tsx"),
  ]);

  assert.match(page, /PersistentAgentChat/);
  assert.match(chat, /\/api\/ai\/conversations/);
  assert.match(chat, /consumeAiEventStream/);
  assert.match(chat, /AiMessageContent/);
  assert.match(chat, /body: JSON\.stringify\(\{ message: content \}\)/);
  assert.doesNotMatch(chat, /body: JSON\.stringify\(\{[^}]*history/);
});

test("strategy studio generates a validated server-side DSL without client history", async () => {
  const studio = await source("../app/community-strategy-center.tsx");

  assert.match(studio, /\/api\/strategy-studio\/generate/);
  assert.match(studio, /consumeAiEventStream/);
  assert.match(studio, /generatedSpecification/);
  assert.match(studio, /generationId/);
  assert.doesNotMatch(studio, /\/api\/strategy-studio\/chat/);
  assert.doesNotMatch(studio, /generationMode,\s*specification/);
  assert.doesNotMatch(studio, /conversation:\s*messages|history:\s*messages/);
});

test("customer AI workspaces expose the private LLM configuration", async () => {
  const [chat, studio, config] = await Promise.all([
    source("../app/agent-chat.tsx"),
    source("../app/community-strategy-center.tsx"),
    source("../app/llm-config.tsx"),
  ]);

  assert.match(chat, /<CustomLlmButton\s*\/>/);
  assert.match(studio, /<CustomLlmButton\s*\/>/);
  assert.match(config, /endpoint="\/api\/account\/llm-config"/);
  assert.match(config, /type="password"/);
});
