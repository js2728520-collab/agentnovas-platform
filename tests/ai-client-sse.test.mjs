import assert from "node:assert/strict";
import test from "node:test";

import { consumeAiEventStream } from "../app/ai-sse.ts";

test("consumes split SSE frames without losing streamed text", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "event: meta\ndata: {\"conversationId\":\"conversation-1\"}\n\nevent: del",
    "ta\ndata: {\"text\":\"第一段\"}\n\nevent: delta\ndata: {\"text\":\"第二段\"}\n\n",
    "event: done\ndata: {\"message\":{\"id\":\"message-1\"}}\n\n",
  ];
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const events = [];

  await consumeAiEventStream(response, (event, data) => events.push({ event, data }));

  assert.deepEqual(events.map((item) => item.event), ["meta", "delta", "delta", "done"]);
  assert.equal(events.filter((item) => item.event === "delta").map((item) => item.data.text).join(""), "第一段第二段");
});

test("surfaces structured non-stream API errors", async () => {
  const response = Response.json({ error: { message: "请求过于频繁" } }, { status: 429 });

  await assert.rejects(
    consumeAiEventStream(response, () => undefined),
    /请求过于频繁/,
  );
});
