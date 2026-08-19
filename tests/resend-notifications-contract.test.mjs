import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEND_SENDER_DOMAIN,
  notificationChannelStatus,
  publicEmailIntegrationStatus,
  resendSenderForCategory,
} from "../lib/notifications.ts";

test("Resend is scoped to the dedicated sender subdomain and never exposes API keys", () => {
  assert.equal(RESEND_SENDER_DOMAIN, "mail.agentnovas.com");
  assert.equal(resendSenderForCategory("account"), "account@mail.agentnovas.com");
  assert.equal(resendSenderForCategory("deposit"), "notice@mail.agentnovas.com");
  assert.equal(resendSenderForCategory("operations"), "operations@mail.agentnovas.com");
  const status = publicEmailIntegrationStatus({
    configured: true,
    senderDomainVerified: true,
    apiKeyPresent: true,
    lastTestAt: "2026-08-19T00:00:00.000Z",
  });
  assert.deepEqual(status, {
    provider: "resend",
    senderDomain: "mail.agentnovas.com",
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

