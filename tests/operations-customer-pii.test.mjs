import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CUSTOMER_PII_PERMISSION_KEYS,
  customerPiiAccessRequest,
  customerPiiAuditPayload,
  operationsCustomerCsv,
  projectOperationsCustomerPii,
  restrictCustomerPiiScope,
} from "../lib/operations-customer-pii.ts";
import { ResearchApiError } from "../lib/research-errors.ts";

const raw = {
  email: "alice@example.com",
  phone: "+8613812345678",
  telegram: "@alice",
  whatsapp: "+8613812345678",
  registrationIpAddress: "203.0.113.25",
  lastLoginIpAddress: "198.51.100.42",
  lastLoginUserAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
  cumulativeDepositUsdt: "1200.50",
  cumulativeSpendUsdt: "99.00",
  exchangeAccounts: [{ id: "acc-1", exchange: "okx", label: "main", environment: "demo", status: "active", canRead: true, canTrade: true, lastCheckedAt: null }],
  openPositions: [{ id: "trade-1", exchangeAccountId: "acc-1", symbol: "BTC-USDT", side: "buy", quantity: "0.1", entryValueUsdt: "6500", openedAt: "2026-08-23T00:00:00.000Z" }],
};

test("customer PII defaults to a stable masked projection and reveals only requested categories", () => {
  const masked = projectOperationsCustomerPii(raw, []);
  assert.equal(masked.contact.email, "al***@example.com");
  assert.notEqual(masked.contact.phone, raw.phone);
  assert.equal(masked.security.registrationIpAddress, "203.0.113.x");
  assert.equal(masked.security.device, null);
  assert.equal(masked.financial.cumulativeDepositUsdt, null);
  assert.deepEqual(masked.trading.exchangeAccounts, []);

  const contact = projectOperationsCustomerPii(raw, ["contact"]);
  assert.equal(contact.contact.email, raw.email);
  assert.equal(contact.contact.phone, raw.phone);
  assert.equal(contact.security.registrationIpAddress, "203.0.113.x");
  assert.equal(contact.financial.cumulativeSpendUsdt, null);

  const all = projectOperationsCustomerPii(raw, ["contact", "security", "financial", "trading"]);
  assert.equal(all.security.registrationIpAddress, raw.registrationIpAddress);
  assert.equal(all.security.device, "Chrome · macOS");
  assert.equal(all.financial.cumulativeDepositUsdt, raw.cumulativeDepositUsdt);
  assert.deepEqual(all.trading.exchangeAccounts, raw.exchangeAccounts);
  assert.deepEqual(all.trading.openPositions, raw.openPositions);
});

test("explicit PII access is fail closed and requires a bounded business reason", () => {
  const permissions = {
    [CUSTOMER_PII_PERMISSION_KEYS.contact]: "ORGANIZATION",
  };
  assert.deepEqual(customerPiiAccessRequest(new Request("https://zht.agentnovas.com/customers"), permissions), {
    categories: [],
    reason: null,
  });
  assert.throws(
    () => customerPiiAccessRequest(new Request("https://zht.agentnovas.com/customers?pii=contact"), permissions),
    (error) => error instanceof ResearchApiError && error.code === "CUSTOMER_PII_REASON_REQUIRED" && error.status === 422,
  );
  assert.throws(
    () => customerPiiAccessRequest(new Request("https://zht.agentnovas.com/customers?pii=financial", { headers: { "x-customer-pii-reason": encodeURIComponent("处理客户已授权的账务核对") } }), permissions),
    (error) => error instanceof ResearchApiError && error.code === "CUSTOMER_PII_FORBIDDEN" && error.status === 403,
  );
  assert.throws(
    () => customerPiiAccessRequest(new Request("https://zht.agentnovas.com/customers?pii=unknown", { headers: { "x-customer-pii-reason": encodeURIComponent("处理客户已授权的资料核对") } }), permissions),
    (error) => error instanceof ResearchApiError && error.code === "CUSTOMER_PII_CATEGORY_INVALID" && error.status === 422,
  );
  assert.deepEqual(customerPiiAccessRequest(new Request("https://zht.agentnovas.com/customers?pii=contact", { headers: { "x-customer-pii-reason": encodeURIComponent("处理客户已授权的资料核对") } }), permissions), {
    categories: ["contact"],
    reason: "处理客户已授权的资料核对",
  });
});

test("PII data scope is the intersection of customer view and every requested field grant", () => {
  const grants = {
    "ops.customers.pii_contact": { scope: "ORGANIZATION", organizationIds: ["branch-a", "branch-b"] },
    "ops.customers.pii_financial": { scope: "TEAM_TREE", organizationIds: ["branch-a"] },
  };
  assert.deepEqual(restrictCustomerPiiScope({
    base: { scope: "PLATFORM", organizationIds: [] },
    categories: ["contact", "financial"],
    grants,
    identityOrganizationId: "branch-a",
  }), { scope: "TEAM_TREE", organizationIds: ["branch-a"] });
  assert.throws(() => restrictCustomerPiiScope({
    base: { scope: "ORGANIZATION_SET", organizationIds: ["branch-b"] },
    categories: ["financial"],
    grants,
    identityOrganizationId: "branch-a",
  }), (error) => error instanceof ResearchApiError && error.code === "CUSTOMER_PII_SCOPE_EMPTY" && error.status === 403);
});

test("PII audit metadata is useful without persisting customer plaintext", () => {
  const payload = customerPiiAuditPayload({
    categories: ["contact", "security"],
    reason: "核对 alice@example.com、13812345678 与 203.0.113.25 的异常登录",
    scope: "ORGANIZATION",
    organizationIds: ["branch-1"],
    resultCount: 2,
    requestId: "request-1",
  });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /alice@example\.com|13812345678|203\.0\.113\.25/);
  assert.match(serialized, /\[EMAIL\]|\[PHONE\]|\[IP\]/);
  assert.deepEqual(payload.categories, ["contact", "security"]);
  assert.equal(payload.resultCount, 2);
});

test("customer CSV uses the same projection and blocks spreadsheet formula injection", () => {
  const csv = operationsCustomerCsv([
    {
      customerId: "=cmd|' /C calc'!A0",
      status: "active",
      registeredAt: "2026-08-23T00:00:00.000Z",
      pii: projectOperationsCustomerPii(raw, ["contact", "financial"]),
    },
  ], ["contact", "financial"]);
  assert.match(csv, /^\uFEFF/);
  assert.match(csv, /"'=cmd\|' \/C calc'!A0"/);
  assert.match(csv, /alice@example\.com/);
  assert.match(csv, /1200\.50/);
  assert.doesNotMatch(csv, /203\.0\.113\.25|BTC-USDT/);
});

test("customer PII permissions are registered and migration-backed", async () => {
  const [rbac, migration] = await Promise.all([
    readFile(new URL("../lib/rbac.ts", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0068_operations_customer_pii_permissions.sql", import.meta.url), "utf8"),
  ]);
  for (const key of [...Object.values(CUSTOMER_PII_PERMISSION_KEYS), "ops.customers.export"]) {
    assert.match(rbac, new RegExp(key.replaceAll(".", "\\.")));
    assert.match(migration, new RegExp(key.replaceAll(".", "\\.")));
  }
});

test("customer list, detail, and export share PII policy, scope filter, and audit primitives", async () => {
  const [list, detail, exportRoute, query, service] = await Promise.all([
    readFile(new URL("../app/api/operations/customers/route.operations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/customers/[id]/route.operations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/customers/export/route.operations.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/operations-customer-query.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/operations-customer-pii-service.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [list, detail, exportRoute]) {
    assert.match(source, /customerPiiAccessRequest/);
    assert.match(source, /projectOperationsCustomerPii/);
    assert.match(source, /recordOperationsCustomerPiiAudit/);
  }
  assert.match(list, /operationsCustomerFilter/);
  assert.match(exportRoute, /operationsCustomerFilter/);
  assert.match(query, /commercialCustomerScopePredicate/);
  assert.match(exportRoute, /ops\.customers\.export/);
  assert.match(exportRoute, /MAX_EXPORT_ROWS = 5_000/);
  assert.match(exportRoute, /x-export-retention.*none/s);
  assert.doesNotMatch(service, /encrypted_credential_ref|withdrawal_credential_ref/);
  assert.match(service, /customer\.registered/);
  assert.match(service, /customer\.pii_export_generated|customer\.pii_viewed/);
});

test("Operations can read only non-secret exchange account metadata", async () => {
  const roles = await readFile(new URL("../deploy/postgres/least-privilege-roles.sql", import.meta.url), "utf8");
  const grant = roles.match(/GRANT SELECT \(([^)]+)\) ON exchange_accounts TO agentnovas_ops_web;/s);
  assert.ok(grant, "Operations exchange-account metadata grant is missing");
  for (const column of [
    "id", "customer_id", "exchange", "label", "environment", "status",
    "can_read", "can_trade", "last_checked_at", "created_at",
  ]) {
    assert.match(grant[1], new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(grant[1], /encrypted_credential_ref|withdrawal_credential_ref|withdrawal_authorized/);
});
