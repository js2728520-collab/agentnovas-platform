import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readMigration = (name) =>
  readFile(new URL(`../postgres/migrations/${name}`, import.meta.url), "utf8");

test("ledger invariants migration is append-only, balanced and idempotent", async () => {
  const sql = await readMigration("0022_ledger_approval_invariants.sql");
  assert.match(sql, /reversal_of_transaction_id/i);
  assert.match(sql, /request_id/i);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(sql, /LEDGER_APPEND_ONLY/i);
  assert.match(sql, /CREATE UNIQUE INDEX[\s\S]+source_type[\s\S]+source_id/i);
  assert.match(sql, /WHERE owner_user_id IS NULL/i);
});

test("commercial migration seeds immutable v1 price snapshots and approval primitives", async () => {
  const sql = await readMigration("0023_commercial_membership_settlement.sql");
  for (const fragment of [
    "membership_monthly_v1",
    "membership_quarterly_v1",
    "membership_annual_v1",
    "membership_lifetime_v1",
    "28",
    "58",
    "198",
    "588",
    "1000",
    "3000",
    "12000",
    "36000",
    "2000",
    "1600",
    "commercial_membership_orders",
    "commercial_payment_evidence",
    "membership_entitlement_events",
    "ai_credit_accounts",
    "ai_credit_ledger_entries",
    "ai_credit_reservations",
    "performance_fee_statements",
    "performance_fee_high_water_marks",
    "performance_fee_receivables",
  ])
    assert.ok(sql.includes(fragment), `missing ${fragment}`);
  assert.match(
    sql,
    /price_currency text NOT NULL DEFAULT 'USD' CHECK \(price_currency = 'USD'\)/i,
  );
  assert.match(
    sql,
    /currency text NOT NULL DEFAULT 'USDT' CHECK \(currency = 'USDT'\)/i,
  );
  assert.doesNotMatch(sql, /request_id text NOT NULL UNIQUE/i);
  assert.match(sql, /revision integer NOT NULL DEFAULT 1/i);
  assert.match(sql, /replaces_statement_id text/i);
  assert.match(sql, /payment_evidence_id text/i);
  assert.match(sql, /status text NOT NULL DEFAULT 'recorded'/i);
  assert.match(sql, /WHERE status <> 'rejected'/i);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX[^;]+commercial_payment_evidence\s*\(currency,\s*reference_fingerprint\)/i,
  );
  assert.doesNotMatch(
    sql,
    /CREATE UNIQUE INDEX[^;]+commercial_payment_evidence\s*\(evidence_kind,/i,
  );
  assert.match(
    sql,
    /commercial_membership_order_decisions[\s\S]+payment_evidence_id text REFERENCES commercial_payment_evidence/i,
  );
  assert.match(
    sql,
    /FOREIGN KEY\s*\(payment_evidence_id,\s*order_id\)[\s\S]+REFERENCES commercial_payment_evidence\s*\(id,\s*membership_order_id\)/i,
  );
  assert.match(
    sql,
    /FOREIGN KEY\s*\(payment_evidence_id,\s*statement_id\)[\s\S]+REFERENCES commercial_payment_evidence\s*\(id,\s*performance_statement_id\)/i,
  );
  assert.match(
    sql,
    /commercial_membership_order_decisions[\s\S]+ALTER COLUMN payment_evidence_id SET NOT NULL/i,
  );
  assert.match(sql, /stage='payment'[\s\S]+payment_evidence_id IS NOT NULL/i);
});
