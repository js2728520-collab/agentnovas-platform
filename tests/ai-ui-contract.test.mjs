import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("agent page uses persistent server conversations and streamed messages", async () => {
  const [page, chat] = await Promise.all([
    source("../app/client-app.tsx"),
    source("../app/agent-chat.tsx"),
  ]);

  assert.match(page, /PersistentAgentChat/);
  assert.match(chat, /\/api\/ai\/conversations/);
  assert.match(chat, /consumeAiEventStream/);
  assert.match(chat, /AiMessageContent/);
  assert.match(chat, /onAnswer=\{\(answer\) => void send\(answer\)\}/);
  assert.match(chat, /body: JSON\.stringify\(\{ message: content \}\)/);
  assert.doesNotMatch(chat, /body: JSON\.stringify\(\{[^}]*history/);
});

test("strategy creation uses the resumable multi-Agent pipeline without a duplicate chat workflow", async () => {
  const [studio, research] = await Promise.all([
    source("../app/community-strategy-center.tsx"),
    source("../app/multi-agent-research.tsx"),
  ]);

  assert.match(studio, /<MultiAgentResearch/);
  assert.match(studio, /后台研发任务会继续运行/);
  assert.doesNotMatch(studio, /ensureStrategyConversation/);
  assert.doesNotMatch(studio, /\/api\/strategy-studio\/generate/);
  assert.doesNotMatch(studio, /className="strategy-chat-panel"/);
  assert.match(research, /\/api\/strategy-research\/runs\?scope=latest&limit=1/);
  assert.match(research, /正在恢复最近的研发任务/);
  assert.doesNotMatch(research, /ensureConversation/);
  assert.doesNotMatch(research, /conversationId,/);
});

test("shared AI message UI exposes an accessible confirmation dialog and custom answer", async () => {
  const [content, styles] = await Promise.all([
    source("../app/ai-message-content.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(content, /<dialog/);
  assert.match(content, /<fieldset/);
  assert.match(content, /type="radio"/);
  assert.match(content, /自定义填写/);
  assert.match(content, /确认并发送/);
  assert.match(content, /<div[^>]*className="ai-message-question-cta"[^>]*>/);
  assert.doesNotMatch(content, /<aside className="ai-message-question-cta">/);
  assert.match(styles, /\.ai-answer-dialog\[open\]\{position:fixed;left:50%;top:50%;right:auto;bottom:auto;margin:0;transform:translate\(-50%,-50%\)/);
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

test("Agent conversation history hides legacy empty strategy threads", async () => {
  const conversations = await source("../lib/ai-conversations.ts");

  assert.match(conversations, /row\.purpose === "consultation" \|\| messageCount > 0/);
});

test("strategy research instrument loading exposes retry state and server proxy support", async () => {
  const [research, packageSource] = await Promise.all([
    source("../app/multi-agent-research.tsx"),
    source("../package.json"),
  ]);

  assert.match(research, /instrumentError/);
  assert.match(research, /重新读取合约/);
  assert.match(research, /setInstrumentBusy\(true\)/);
  assert.match(packageSource, /NODE_USE_ENV_PROXY=1 next dev/);
  assert.match(packageSource, /NODE_USE_ENV_PROXY=1 next start/);
});
