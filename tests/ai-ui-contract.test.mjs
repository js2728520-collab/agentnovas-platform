import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("agent page uses persistent server conversations and streamed messages", async () => {
  // 助手此前是遗留 SPA 里动态导入的 PersistentAgentChat，现在是真实路由 /assistant，
  // 那个导入名不再存在。真正要守的是「服务端持久会话 + 流式消息」。
  const chat = await source("../apps/client/ui/ai-assistant-chat.tsx");

  assert.match(chat, /\/api\/ai\/conversations/);
  assert.match(chat, /consumeAiEventStream/);
  assert.match(chat, /AiMessageContent/);
  assert.match(chat, /onAnswer=\{\(answer\) => void send\(answer\)\}/);
  assert.match(chat, /body: JSON\.stringify\(\{ message: pendingRequest\.content \}\)/);
  assert.doesNotMatch(chat, /body: JSON\.stringify\(\{[^}]*history/);
});

test("strategy creation uses the resumable multi-Agent pipeline without a duplicate chat workflow", async () => {
  // 研发问卷与流水线驱动现在同在 apps/client/ui/strategy-studio.tsx（P4 迁移）。
  const studio = await source("../apps/client/ui/strategy-studio.tsx");
  const research = studio;

  assert.match(studio, /\/api\/strategy-research\/runs/);
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
    source("../apps/client/ui/ai-message-content.tsx"),
    source("../app/globals-beta.css"),
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

test("customer AI workspaces use the platform model without exposing private LLM configuration", async () => {
  const [page, chat, studio] = await Promise.all([
    source("../apps/client/ui/ai-assistant-chat.tsx"),
    source("../apps/client/ui/ai-assistant-chat.tsx"),
    source("../apps/client/ui/strategy-studio.tsx"),
  ]);

  for (const reachable of [page, chat, studio]) {
    assert.doesNotMatch(reachable, /CustomLlmButton|account\/llm-config|\.\/llm-config/);
  }
  assert.match(chat, /平台模型服务/);
  assert.match(studio, /平台模型/);
});

test("Agent conversation history hides legacy empty strategy threads", async () => {
  const conversations = await source("../lib/ai-conversations.ts");

  assert.match(conversations, /row\.purpose === "consultation" \|\| messageCount > 0/);
});

test("strategy research instrument loading exposes retry state and server proxy support", async () => {
  const [research, packageSource] = await Promise.all([
    source("../apps/client/ui/strategy-studio.tsx"),
    source("../package.json"),
  ]);

  assert.match(research, /instrumentError/);
  assert.match(research, /重新读取合约/);
  assert.match(research, /setInstrumentBusy\(true\)/);
  assert.match(packageSource, /NODE_USE_ENV_PROXY=1 next dev/);
  assert.match(packageSource, /NODE_USE_ENV_PROXY=1 next start/);
});
