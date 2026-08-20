import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyResendHttpStatus,
  claimNextEmailDelivery,
  markEmailSent,
  notificationSendEnvironmentReady,
  processClaimedEmail,
  providerConfigAllowsSend,
  renderNotificationEmail,
  retryDelayMilliseconds,
  sendResendEmail,
  validateEmailRecipient,
} from "../lib/notification-email-worker.ts";

test("known notification templates render bounded escaped email", () => {
  const reset = renderNotificationEmail("reset_password", { token: "a&b" });
  assert.match(reset.text, /https:\/\/agentnovas\.com\/reset-password\?token=a%26b/);
  assert.doesNotMatch(reset.html, /a&b/);

  const invite = renderNotificationEmail("internal_account_invite", {
    verifyToken: "verify-token",
    temporaryPassword: "temporary-password",
    role: "manager",
  });
  assert.match(invite.subject, /内部账号邀请/);
  assert.match(invite.text, /https:\/\/zht\.agentnovas\.com\/verify-email\?token=verify-token/);

  const brief = renderNotificationEmail("team_daily_brief", {
    date: "2026-08-20",
    month: "2026-08",
    scope: "manager",
    summary: { customers: 3, collections: 2, stopped: 1, expiring: 4, openTrades: 5, targetMissing: 6 },
  });
  assert.match(brief.text, /客户数：3/);

  const delist = renderNotificationEmail("strategy_delist_notice", {
    strategyId: "strategy-1",
    strategyName: "A < B",
    action: "delist",
    noticeEndsAt: "2026-08-27T00:00:00.000Z",
  });
  assert.match(delist.html, /A &lt; B/);

  const modify = renderNotificationEmail("strategy_modify_notice", {
    strategyId: "strategy-1",
    strategyName: "策略一",
    action: "modify",
    noticeEndsAt: "2026-08-27T00:00:00.000Z",
  });
  assert.match(modify.text, /申请修改/);
});

test("unknown templates and malformed payloads are rejected", () => {
  assert.throws(() => renderNotificationEmail("unrecognized", {}), /UNKNOWN_TEMPLATE/);
  assert.throws(() => renderNotificationEmail("reset_password", { token: "" }), /INVALID_PAYLOAD/);
  assert.throws(() => renderNotificationEmail("strategy_delist_notice", {
    strategyId: "strategy-1",
    strategyName: "name",
    action: "modify",
    noticeEndsAt: "2026-08-27T00:00:00.000Z",
  }), /INVALID_PAYLOAD/);
});

test("recipient and all send gates must be production-ready", () => {
  assert.equal(validateEmailRecipient("person@example.com"), true);
  assert.equal(validateEmailRecipient("person@unverified.agentnovas.local"), false);
  assert.equal(validateEmailRecipient("not-an-email"), false);
  assert.equal(notificationSendEnvironmentReady({
    NOTIFICATION_WORKER_ENABLED: "true",
    NOTIFICATION_EMAIL_SEND_ENABLED: "true",
    NODE_ENV: "production",
    RESEND_API_KEY: "secret",
  }), true);
  assert.equal(notificationSendEnvironmentReady({
    NOTIFICATION_WORKER_ENABLED: "true",
    NOTIFICATION_EMAIL_SEND_ENABLED: "true",
    NODE_ENV: "test",
    RESEND_API_KEY: "secret",
  }), false);
  assert.equal(providerConfigAllowsSend({
    provider: "resend",
    channel: "email",
    status: "active",
    sender_domain: "agentnovas.com",
    settings_json: { senderDomainVerified: true },
  }), true);
  assert.equal(providerConfigAllowsSend({
    provider: "resend",
    channel: "email",
    status: "active",
    sender_domain: "mail.agentnovas.com",
    settings_json: { senderDomainVerified: true },
  }), false);
});

test("Resend status and backoff classification are bounded", () => {
  for (const status of [408, 409, 425, 429, 500, 503]) assert.equal(classifyResendHttpStatus(status), "retryable");
  for (const status of [400, 401, 403, 404, 422]) assert.equal(classifyResendHttpStatus(status), "permanent");
  assert.equal(retryDelayMilliseconds(1), 30_000);
  assert.equal(retryDelayMilliseconds(99), 480_000);
});

test("Resend sender, endpoint and idempotency key are fixed", async () => {
  let request;
  const result = await sendResendEmail({
    apiKey: "test-secret",
    deliveryId: "delivery-1",
    recipient: "PERSON@example.com",
    rendered: { subject: "Subject", text: "Text", html: "<p>Text</p>" },
    fetchImplementation: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: "provider-1" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(result, { ok: true, providerMessageId: "provider-1" });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.init.headers["Idempotency-Key"], "notification-delivery/delivery-1");
  assert.equal(request.body.from, "noreply@agentnovas.com");
  assert.deepEqual(request.body.to, ["person@example.com"]);
  assert.deepEqual(request.body.tags, [{ name: "notification_delivery_id", value: "delivery-1" }]);
});

test("claim uses a fenced SKIP LOCKED lease and sent updates require owner", async () => {
  const queries = [];
  const client = {
    query: async (sql, parameters) => {
      queries.push({ sql, parameters });
      if (/RETURNING/.test(sql)) return { rows: [{ id: "delivery-1", userId: "user-1", templateKey: "reset_password", payloadJson: { token: "x" }, attempts: 1, recipient: "person@example.com" }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: async (sql, parameters) => { queries.push({ sql, parameters }); return { rowCount: 1, rows: [] }; } };
  const delivery = await claimNextEmailDelivery(pool, { workerId: "worker-1", now: new Date("2026-08-20T00:00:00.000Z") });
  assert.equal(delivery.id, "delivery-1");
  assert.match(queries.find(query => /SKIP LOCKED/.test(query.sql)).sql, /FOR UPDATE OF delivery SKIP LOCKED/);
  assert.equal(queries.find(query => /SKIP LOCKED/.test(query.sql)).parameters[2], 5);
  await markEmailSent(pool, { deliveryId: "delivery-1", workerId: "worker-1", providerMessageId: "provider-1", now: new Date("2026-08-20T00:00:01.000Z") });
  assert.match(queries.at(-1).sql, /lease_owner = \$2/);
  assert.match(queries.at(-1).sql, /status IN \('delivered', 'failed'\)/);
});

test("invalid synthetic recipient fails permanently without invoking sender", async () => {
  const updates = [];
  const pool = { query: async (sql, parameters) => { updates.push({ sql, parameters }); return { rowCount: 1, rows: [] }; } };
  let sent = false;
  const result = await processClaimedEmail(pool, {
    id: "delivery-1",
    userId: "user-1",
    templateKey: "reset_password",
    payloadJson: { token: "secret-token" },
    attempts: 1,
    recipient: "generated@unverified.agentnovas.local",
  }, {
    workerId: "worker-1",
    apiKey: "unused",
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    send: async () => { sent = true; return { ok: true, providerMessageId: "never" }; },
  });
  assert.equal(sent, false);
  assert.deepEqual(result, { status: "failed", errorCode: "INVALID_RECIPIENT" });
  assert.equal(updates[0].parameters[2], "failed");
  assert.equal(updates[0].parameters[3], "INVALID_RECIPIENT");
});

test("a fenced delivery update is never reported as sent", async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  const result = await processClaimedEmail(pool, {
    id: "delivery-1",
    userId: "user-1",
    templateKey: "reset_password",
    payloadJson: { token: "secret-token" },
    attempts: 1,
    recipient: "person@example.com",
  }, {
    workerId: "stale-worker",
    apiKey: "test-key",
    send: async () => ({ ok: true, providerMessageId: "provider-1" }),
  });
  assert.deepEqual(result, { status: "fenced", providerMessageId: "provider-1" });
});
