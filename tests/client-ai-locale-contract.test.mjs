import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Client AI response language is derived from the authenticated server preference", async () => {
  const [route, assistant] = await Promise.all([
    read("app/api/ai/conversations/[id]/messages/route.client.ts"),
    read("lib/ai-assistant.ts"),
  ]);

  assert.match(route, /readUserAppPreference/);
  assert.match(route, /session\.tokenHash/);
  assert.match(route, /locale: preference\.locale/);
  assert.match(route, /requestPayload = \{ conversationId: id, message: content, locale/);
  assert.match(assistant, /responseLanguageForLocale/);
  assert.match(assistant, /output language/i);
  assert.doesNotMatch(route, /body\.locale/);
});
