import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeNotificationPreferenceBatch } from "../lib/notification-preferences.ts";

test("notification preference batch validates a complete quiet-hours schedule", () => {
  const entries = normalizeNotificationPreferenceBatch({
    quietStart: "22:30",
    quietEnd: "07:15",
    preferences: [
      { category: "api_security", channel: "in_app", mode: "instant" },
      { category: "market_news", channel: "email", mode: "disabled" },
    ],
  });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ quietStart, quietEnd }) => ({ quietStart, quietEnd })), [
    { quietStart: "22:30", quietEnd: "07:15" },
    { quietStart: "22:30", quietEnd: "07:15" },
  ]);
});

test("mandatory categories cannot be disabled and duplicate rows are rejected", () => {
  assert.throws(() => normalizeNotificationPreferenceBatch({
    quietStart: "22:00", quietEnd: "07:00",
    preferences: [{ category: "api_security", channel: "email", mode: "disabled" }],
  }), (error) => error?.code === "MANDATORY_NOTIFICATION");
  assert.throws(() => normalizeNotificationPreferenceBatch({
    quietStart: "22:00", quietEnd: "07:00",
    preferences: [
      { category: "market_news", channel: "email", mode: "instant" },
      { category: "market_news", channel: "email", mode: "digest" },
    ],
  }), (error) => error?.code === "DUPLICATE_NOTIFICATION_PREFERENCE");
});

test("Client notification UI sends quiet hours in one batch without optimistic overwrite", async () => {
  const source = await readFile(new URL("../apps/client/ui/client-notification-settings.tsx", import.meta.url), "utf8");
  assert.match(source, /quietStart/);
  assert.match(source, /quietEnd/);
  assert.match(source, /preferences: categories\.flatMap/);
  assert.match(source, /通知偏好与免打扰时段已保存/);
});
