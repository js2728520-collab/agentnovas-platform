import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeNotificationPreferenceBatch } from "../lib/notification-preferences.ts";
import {
  notificationQuietHoursPayload,
  resolveNotificationQuietHours,
} from "../apps/client/ui/client-notification-preferences-model.ts";

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

test("Client notification UI saves every channel and quiet hours in one consistent form", async () => {
  const source = await readFile(new URL("../apps/client/ui/client-notification-settings.tsx", import.meta.url), "utf8");
  assert.match(source, /quietStart/);
  assert.match(source, /quietEnd/);
  assert.match(source, /preferences: categories\.flatMap/);
  assert.match(source, /<form/);
  assert.match(source, /保存通知设置/);
  assert.match(source, /通知设置已保存/);
  assert.match(source, /启用免打扰/);
  assert.doesNotMatch(source, /Telegram|WhatsApp|not_integrated/);
});

test("notification quiet hours remain disabled until the customer enables them", () => {
  assert.deepEqual(resolveNotificationQuietHours([]), {
    enabled: false,
    start: "22:00",
    end: "07:00",
  });
  assert.deepEqual(notificationQuietHoursPayload(false, "22:00", "07:00"), {
    quietStart: null,
    quietEnd: null,
  });
  assert.deepEqual(notificationQuietHoursPayload(true, "21:30", "06:45"), {
    quietStart: "21:30",
    quietEnd: "06:45",
  });
});

test("notification quiet hours restore an existing saved schedule", () => {
  assert.deepEqual(resolveNotificationQuietHours([
    { quietStart: null, quietEnd: null },
    { quietStart: "23:15", quietEnd: "08:00" },
  ]), {
    enabled: true,
    start: "23:15",
    end: "08:00",
  });
});
