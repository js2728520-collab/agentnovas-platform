import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0042 adds an immutable, replay-safe Udun deposit-only boundary", async () => {
  const sql = await readFile(new URL("../postgres/migrations/0042_udun_deposit_gateway.sql", import.meta.url), "utf8");
  assert.match(sql, /deposit_provider_events/);
  assert.match(sql, /UNIQUE\(provider,provider_event_id\)/);
  assert.match(sql, /UNIQUE\(provider,nonce_sha256\)/);
  assert.match(sql, /deposit_provider_events_append_only/);
  assert.match(sql, /idx_deposit_orders_user_idempotency/);
  assert.match(sql, /idx_deposit_orders_one_open_udun_order/);
  assert.match(sql, /idx_deposit_orders_provider_address_unique/);
  assert.match(sql, /client_payment_provider_configs_safe/);
  assert.match(sql, /payment_webhook_provider_configs_safe/);
  assert.match(sql, /'udun-usdt-trc20'/);
  assert.match(sql, /'disabled'/);
  assert.match(sql, /"autoCredit":false/);
  assert.doesNotMatch(sql, /api[_-]?key\s*[:=]\s*["'][^"']+/i);
  assert.doesNotMatch(sql, /withdraw(?:al)?_endpoint|\/mch\/withdraw/i);
});
