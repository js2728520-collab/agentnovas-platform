import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Client address creation uses the safe projection, server-side runtime secret, and no static address", async () => {
  const route = await read("app/api/wallet/deposit-orders/route.client.ts");
  assert.match(route, /client_payment_provider_configs_safe/);
  assert.match(route, /readUdunRuntimeConfig/);
  assert.match(route, /requestUdunDepositAddress/);
  assert.match(route, /idempotencyKey\(request\)/);
  assert.match(route, /existingOpenOrder/);
  assert.match(route, /user\.organizationId/);
  assert.doesNotMatch(route, /FROM users/i);
  assert.doesNotMatch(route, /settings_json\?\.depositAddress|depositAddress\s*=\s*["'`]/);
  assert.doesNotMatch(route, /\/mch\/withdraw|withdraw\(/);
});

test("Udun webhook uses its dedicated role and persists hashes instead of raw provider payloads", async () => {
  const [route, postgres, roles] = await Promise.all([
    read("app/api/integrations/payments/[provider]/webhook/route.maintenance.ts"),
    read("lib/postgres.ts"),
    read("deploy/postgres/least-privilege-roles.sql"),
  ]);
  assert.match(route, /getPaymentWebhookPostgresPool/);
  assert.match(route, /verifyUdunEnvelope/);
  assert.match(route, /assertFreshUdunTimestamp/);
  assert.match(route, /payload_sha256,nonce_sha256/);
  assert.doesNotMatch(route, /INSERT INTO deposit_provider_events[\s\S]*raw_payload/i);
  assert.match(postgres, /PAYMENT_WEBHOOK_DATABASE_URL 必须使用 agentnovas_payment_webhook/);
  assert.match(route, /payment_webhook_provider_configs_safe/);
  assert.match(roles, /GRANT SELECT ON payment_webhook_provider_configs_safe TO agentnovas_payment_webhook/);
  assert.doesNotMatch(roles, /GRANT SELECT ON payment_provider_configs[^;]*agentnovas_payment_webhook/);
  assert.doesNotMatch(roles, /GRANT[^;]*ON[^;]*(?:users|wallet_balances|ledger_transactions)[^;]*TO agentnovas_payment_webhook/i);
});

test("APPROVE_CREDIT is the only deposit approval that atomically posts wallet and ledger state", async () => {
  const route = await read("app/api/operations/deposit-action-requests/[id]/decisions/route.operations.ts");
  assert.match(route, /row\.action === "APPROVE_CREDIT"/);
  assert.match(route, /transactionType: "deposit_credit"/);
  assert.match(route, /postCommercialLedgerTransaction/);
  assert.match(route, /walletMutation/);
  assert.match(route, /fundsExecuted/);
  assert.match(route, /BEGIN/);
  assert.match(route, /ROLLBACK/);
  assert.match(route, /申请人不能审批自己的资金操作/);
});
