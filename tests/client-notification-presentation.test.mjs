import assert from "node:assert/strict";
import test from "node:test";

import { presentClientNotification } from "../apps/client/ui/client-notification-presentation.ts";

function item(overrides = {}) {
  return {
    id: "notification-1",
    category: "membership",
    templateKey: "membership_activated",
    status: "queued",
    payload: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

test("client notifications translate membership events into customer language", () => {
  assert.deepEqual(presentClientNotification(item({
    payload: { planCode: "monthly_v1", status: "ACTIVE" },
  })), {
    category: "会员",
    title: "会员已激活",
    detail: "会员权益已生效，可在账户中心查看有效期和权益范围。",
  });
});

test("client notifications render safe strategy details without exposing payload keys", () => {
  assert.deepEqual(presentClientNotification(item({
    category: "strategy_lifecycle",
    templateKey: "strategy_delist_notice",
    payload: { strategyName: "AI 稳健型", action: "delist", noticeEndsAt: "2026-09-01T00:00:00.000Z" },
  })), {
    category: "策略",
    title: "策略下架提醒",
    detail: "AI 稳健型将于 2026/09/01 08:00 调整，请及时检查跟随安排。",
  });
});

test("unknown client notifications use a neutral fallback instead of raw template data", () => {
  const result = presentClientNotification(item({
    category: "future_category",
    templateKey: "future_internal_event_v2",
    payload: { internalCode: "DO_NOT_SHOW", requestId: "request-1" },
  }));
  assert.deepEqual(result, {
    category: "平台",
    title: "账户有新的平台通知",
    detail: "通知详情已安全记录；如需协助，请联系客户支持。",
  });
  assert.doesNotMatch(JSON.stringify(result), /future_internal_event|internalCode|DO_NOT_SHOW|requestId/);
});
