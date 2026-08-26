import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deriveConversationTitle,
  guidedAssistantReply,
  serializeSseEvent,
  splitStreamingText,
} from "../lib/ai-chat-protocol.ts";

test("derives a short single-line title from the first user message", () => {
  assert.equal(deriveConversationTitle("  请帮我分析\nBTC 当前风险以及仓位  "), "请帮我分析 BTC 当前风险以及仓位");
  assert.equal(deriveConversationTitle("a".repeat(60)).length, 28);
});

test("serializes named SSE events as one JSON data frame", () => {
  const frame = serializeSseEvent("delta", { text: "第一行\n第二行" });
  assert.equal(frame, "event: delta\ndata: {\"text\":\"第一行\\n第二行\"}\n\n");
  assert.deepEqual(splitStreamingText("1234567890", 4), ["1234", "5678", "90"]);
});

test("guided mode uses supplied tenant context and never claims to place an order", () => {
  const result = guidedAssistantReply("解释我的持仓风险", {
    generatedAt: "2026-08-16T00:00:00.000Z",
    market: null,
    portfolio: {
      openPositions: 2,
      positionSymbols: ["BTCUSDT", "ETHUSDT"],
      followedStrategies: ["AI 稳健型"],
    },
  });

  assert.equal(result.mode, "guided_rules");
  assert.match(result.text, /2 个未平仓记录/);
  assert.doesNotMatch(result.text, /已下单|已经买入|保证收益/);
});

test("message API contract loads history on the server instead of accepting client history", async () => {
  const [routeSource, contextSource] = await Promise.all([
    readFile(new URL("../app/api/ai/conversations/[id]/messages/route.client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-context.ts", import.meta.url), "utf8"),
  ]);
  assert.match(routeSource, /getConversationMessages/);
  assert.doesNotMatch(routeSource, /body\.(conversation|history|messages)/);
  assert.match(routeSource, /text\/event-stream/);
  assert.match(routeSource, /consumeAiRequestQuota/);
  assert.match(contextSource, /isNull\(trades\.closedAt\)/);
});
