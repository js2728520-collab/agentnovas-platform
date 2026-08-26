import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEPOSIT_FUNDS_STATUSES,
  DEPOSIT_ORDER_STATUSES,
  DEPOSIT_RISK_RESULTS,
  csvSafeCell,
  depositStateAfterConfirmations,
} from "../lib/deposits.ts";
import {
  addDecimalStrings,
  assertBalancedPostings,
  compareDecimalStrings,
  normalizeDecimalString,
} from "../packages/ledger/src/ledger.ts";

test("deposit contract exposes required states without enabling withdrawals", () => {
  assert.deepEqual(DEPOSIT_ORDER_STATUSES, ["PENDING_CONFIRMATION", "CONFIRMING", "MANUAL_REVIEW", "CREDITED", "FAILED", "RETURNED"]);
  assert.deepEqual(DEPOSIT_FUNDS_STATUSES, ["NOT_CREDITED", "AVAILABLE", "PARTIALLY_FROZEN", "FROZEN", "RETURN_PENDING", "RETURNED"]);
  assert.deepEqual(DEPOSIT_RISK_RESULTS, ["PASS", "REVIEW", "BLOCK"]);
  assert.equal(depositStateAfterConfirmations({ currentConfirmations: 2, requiredConfirmations: 12, riskResult: "PASS" }), "CONFIRMING");
  assert.equal(depositStateAfterConfirmations({ currentConfirmations: 12, requiredConfirmations: 12, riskResult: "REVIEW" }), "MANUAL_REVIEW");
  assert.equal(depositStateAfterConfirmations({ currentConfirmations: 12, requiredConfirmations: 12, riskResult: "PASS" }), "CREDITED");
});

test("ledger math stays exact with decimal strings and rejects unbalanced postings", () => {
  assert.equal(normalizeDecimalString("00059.1000000"), "59.1");
  assert.equal(addDecimalStrings("0.1", "0.2"), "0.3");
  assert.equal(compareDecimalStrings("1.000001", "1.000000"), 1);
  assert.doesNotThrow(() => assertBalancedPostings([
    { side: "debit", amount: "58.00" },
    { side: "debit", amount: "1.00" },
    { side: "credit", amount: "59.00" },
  ]));
  assert.throws(() => assertBalancedPostings([
    { side: "debit", amount: "58.00" },
    { side: "credit", amount: "58.01" },
  ]), /LEDGER_NOT_BALANCED/);
});

test("export cells are escaped against spreadsheet formula injection", () => {
  assert.equal(csvSafeCell("=IMPORTXML(\"https://bad\")"), "'=IMPORTXML(\"https://bad\")");
  assert.equal(csvSafeCell("+100"), "'+100");
  assert.equal(csvSafeCell("normal value"), "normal value");
});

test("PostgreSQL migration creates RBAC, deposit, ledger, notification and session-audience tables", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0015_riverton_three_app_rbac_wallet.sql", import.meta.url), "utf8");
  for (const tableName of [
    "applications",
    "permission_definitions",
    "role_templates",
    "role_template_versions",
    "roles",
    "role_permissions",
    "user_role_assignments",
    "access_change_requests",
    "access_change_decisions",
    "authorization_audit_events",
    "deposit_orders",
    "ledger_accounts",
    "ledger_transactions",
    "ledger_postings",
    "wallet_balances",
    "wallet_balance_versions",
    "payment_provider_configs",
    "reconciliation_runs",
    "notification_provider_configs",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS "${tableName}"`));
  }
  assert.match(migration, /ALTER TABLE "sessions"[\s\S]*"app_audience"/);
  assert.match(migration, /numeric\(36, 18\)/);
  assert.match(migration, /CHECK \("channel" IN \('email', 'telegram', 'whatsapp', 'in_app'\)\)/);
});

