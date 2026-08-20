import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { maintenanceDemoAccountDto } from "../lib/maintenance-demo-view.ts";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Beta payment status endpoint can only preserve or enter disabled state", async () => {
  const [source, list] = await Promise.all([
    read("app/api/maintenance/payment-providers/[id]/status/route.ts"),
    read("app/api/maintenance/payment-providers/route.ts"),
  ]);
  assert.match(source, /BETA_PAYMENT_EXECUTION_DISABLED/);
  assert.match(source, /status\s*!==\s*["']disabled["']/);
  assert.doesNotMatch(source, /new Set\(\[["']sandbox["'],\s*["']active["']/);
  assert.match(list, /configuredStatus:\s*row\.status/);
  assert.match(list, /effectiveStatus:\s*["']disabled["']/);
});

test("Demo control and verification bind reason and payload to an idempotent audit command", async () => {
  const [control, verify, migration] = await Promise.all([
    read("app/api/maintenance/demo-exchanges/[id]/control/route.ts"),
    read("app/api/maintenance/demo-exchanges/[id]/verify/route.ts"),
    read("postgres/migrations/0027_platform_demo_admin_commands.sql"),
  ]);
  for (const source of [control, verify]) {
    assert.match(source, /idempotencyKey\(request\)/);
    assert.match(source, /claimPlatformDemoAdminCommand/);
    assert.match(source, /reason/);
  }
  assert.match(control, /DEMO_KILL_SWITCH_ACTIVE/);
  assert.doesNotMatch(
    control,
    /SET enabled=true,kill_switch_enabled=false/,
  );
  assert.match(migration, /platform_demo_admin_commands/);
  assert.match(migration, /reason text NOT NULL/);
  assert.match(migration, /UNIQUE\s*\(operation,idempotency_key\)/);
});

test("payment evidence DTO never returns unrestricted operator free text", async () => {
  const source = await read("lib/commercial-public-contract.ts");
  const dto = source.slice(source.indexOf("export function paymentEvidenceDto"));
  assert.doesNotMatch(dto.slice(0, dto.indexOf("export function membershipActionDto")), /note:/);
  assert.doesNotMatch(
    dto.slice(0, dto.indexOf("export function membershipActionDto")),
    /providerLabel:/,
  );
});

test("OKX Demo configuration requires a passphrase while other providers do not", () => {
  const base = {
    id: "demo",
    label: "Demo",
    enabled: false,
    kill_switch_enabled: false,
    has_api_key: true,
    has_secret: true,
    has_passphrase: false,
    last_verified_at: null,
    last_verification_status: null,
    verification_fresh: false,
    updated_at: "2026-08-21T00:00:00Z",
    daily_notional: "0",
    daily_intent_count: "0",
    latest_receipt_status: null,
    latest_receipt_filled_quote: null,
    latest_receipt_fee: null,
    latest_receipt_at: null,
  };
  assert.equal(
    maintenanceDemoAccountDto({ ...base, provider: "okx" }, []).configured,
    false,
  );
  assert.equal(
    maintenanceDemoAccountDto({ ...base, provider: "binance" }, []).configured,
    true,
  );
});
