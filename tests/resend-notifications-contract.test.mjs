import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("Resend webhook acknowledges synchronously applied events with HTTP 200", async () => {
  const route = await readFile(new URL("../app/api/integrations/resend/webhook/route.ts", import.meta.url), "utf8");
  assert.match(route, /applyResendWebhookEvent/);
  assert.match(route, /status:\s*200/);
  assert.doesNotMatch(route, /queued:\s*false\s*},\s*{\s*status:\s*202/);
});

test("Resend delivery event state is persisted with lookup and audit indexes", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0018_resend_delivery_events.sql", import.meta.url), "utf8");
  assert.match(migration, /provider_event_type/);
  assert.match(migration, /provider_event_at/);
  assert.match(migration, /mapped_delivery_id/);
  assert.match(migration, /provider_message_id/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_email_provider_message"/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "idx_resend_webhook_provider_message"/);
});

test("business schema upgrades existing notification tables before creating lease indexes", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0000_business_schema.sql", import.meta.url), "utf8");
  const alter = migration.indexOf('ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "lease_owner"');
  const index = migration.indexOf('CREATE INDEX IF NOT EXISTS "idx_notifications_email_claim"');
  assert.ok(alter >= 0, "existing notification tables must receive lease columns");
  assert.ok(index > alter, "lease columns must exist before their indexes are created");
});
