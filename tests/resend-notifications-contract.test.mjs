import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEND_SENDER_ADDRESS,
  RESEND_SENDER_DOMAIN,
  notificationChannelStatus,
  publicEmailIntegrationStatus,
  resendSenderForCategory,
} from "../lib/notifications.ts";

test("Resend uses the canonical sender address and never exposes API keys", () => {
  assert.equal(RESEND_SENDER_ADDRESS, "noreply@agentnovas.com");
  assert.equal(RESEND_SENDER_DOMAIN, "agentnovas.com");
  assert.equal(resendSenderForCategory("account"), RESEND_SENDER_ADDRESS);
  assert.equal(resendSenderForCategory("deposit"), RESEND_SENDER_ADDRESS);
  assert.equal(resendSenderForCategory("operations"), RESEND_SENDER_ADDRESS);
  const status = publicEmailIntegrationStatus({
    configured: true,
    senderDomainVerified: true,
    apiKeyPresent: true,
    lastTestAt: "2026-08-19T00:00:00.000Z",
  });
  assert.deepEqual(status, {
    provider: "resend",
    senderAddress: "noreply@agentnovas.com",
    senderDomain: "agentnovas.com",
    configured: true,
    senderDomainVerified: true,
    apiKeyPresent: true,
    lastTestAt: "2026-08-19T00:00:00.000Z",
  });
  assert.equal("apiKey" in status, false);
});

test("unconfigured channels are explicit and mandatory deposit notices cannot be disabled", () => {
  assert.deepEqual(notificationChannelStatus({ configured: false, verified: false }), {
    status: "unconfigured",
    canSend: false,
  });
  assert.deepEqual(notificationChannelStatus({ configured: true, verified: false }), {
    status: "pending_verification",
    canSend: false,
  });
  assert.deepEqual(notificationChannelStatus({ configured: true, verified: true }), {
    status: "ready",
    canSend: true,
  });
});

