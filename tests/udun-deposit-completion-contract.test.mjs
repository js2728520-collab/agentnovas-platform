import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Udun completion migration adds broker custody, callback evidence, and address provisioning states", async () => {
  const sql = await read("postgres/migrations/0092_udun_deposit_service_completion.sql");
  assert.match(sql, /payment_secret_requests/);
  assert.match(sql, /payment_secret_broker_heartbeats/);
  assert.match(sql, /payment_provider_test_runs/);
  assert.match(sql, /maintenance\.payment_provider\.configuration/);
  assert.match(sql, /maintenance\.payment_provider\.status/);
  assert.match(sql, /maintenance\.payment_provider\.test/);
  assert.match(sql, /maintenance\.payment_provider\.callback_test/);
  assert.match(sql, /last_callback_test_at/);
  assert.match(sql, /ADDRESS_PROVISIONING/);
  assert.match(sql, /ADDRESS_UNKNOWN/);
  assert.match(sql, /ADDRESS_FAILED/);
  assert.match(sql, /idx_deposit_orders_one_open_udun_order/);
  assert.doesNotMatch(sql, /api[_-]?key\s*[:=]\s*["'][^"']+/i);
  assert.doesNotMatch(sql, /\/mch\/withdraw|withdrawal_endpoint/i);
});

test("Client reserves an idempotent order before the one and only provider address call", async () => {
  const route = await read("app/api/wallet/deposit-orders/route.client.ts");
  const reserve = route.indexOf("'ADDRESS_PROVISIONING'");
  const providerCall = route.indexOf("requestUdunDepositAddress({");
  assert.ok(reserve > 0 && providerCall > reserve, "order reservation must precede provider call");
  assert.match(route, /ADDRESS_UNKNOWN/);
  assert.match(route, /ADDRESS_FAILED/);
  assert.match(route, /options:/);
  assert.match(route, /client_payment_provider_configs_safe/);
  assert.match(route, /paymentActivationGate/);
  assert.match(route, /managedConfigurationVersion !== selected\.secret_configuration_version/);
  assert.match(route, /IDEMPOTENCY_KEY_COLLISION/g);
});

test("Webhook follows official form envelope and Nginx exposes only the exact Udun callback path", async () => {
  const [route, nginx, isolation] = await Promise.all([
    read("app/api/integrations/payments/[provider]/webhook/route.maintenance.ts"),
    read("deploy/nginx/riverton-three-apps.conf"),
    read("tests/deployment-isolation.test.mjs"),
  ]);
  assert.match(route, /parseUdunHttpEnvelope/);
  assert.match(nginx, /location = \/api\/integrations\/payments\/udun\/webhook/);
  assert.match(isolation, /exact Udun callback/i);
});

test("Payment Secret Broker and callback contracts stay present in the API documentation", async () => {
  const [catalog, openapi] = await Promise.all([
    read("docs/api/API_CATALOG.md"),
    read("docs/api/openapi-controlled-beta.yaml"),
  ]);
  for (const route of [
    "/api/maintenance/payment-secrets/status",
    "/api/maintenance/payment-secrets/public-key",
    "/api/maintenance/payment-secrets/requests",
    "/api/maintenance/payment-secrets/requests/[id]",
    "/api/maintenance/payment-providers/[id]/callback-test",
  ]) assert.match(catalog, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(openapi, /application\/x-www-form-urlencoded/);
  assert.match(openapi, /\/api\/maintenance\/payment-secrets\/requests:\n/);
  assert.match(openapi, /\/api\/maintenance\/payment-providers\/\{id\}\/callback-test:/);
  assert.match(openapi, /必须来自同一接口 GET 返回的 options\.networks/);
});

test("Client renders only server-provided networks, copies addresses, and polls active orders", async () => {
  const ui = await read("apps/client/ui/deposit-workspace.tsx");
  assert.match(ui, /options\.networks/);
  assert.match(ui, /navigator\.clipboard\.writeText/);
  assert.match(ui, /setInterval/);
  assert.doesNotMatch(ui, /<option value="ERC20">/);
  assert.doesNotMatch(ui, /<option value="BEP20">/);
});

test("Maintenance payment management includes write-only secret configuration and separate callback evidence", async () => {
  const [ui, providerTestRoute, callbackTestRoute] = await Promise.all([
    read("apps/maintenance/ui/payment-integration-workspace.tsx"),
    read("app/api/maintenance/payment-providers/[id]/test/route.maintenance.ts"),
    read("app/api/maintenance/payment-providers/[id]/callback-test/route.maintenance.ts"),
  ]);
  assert.match(ui, /payment-secrets\/public-key/);
  assert.match(ui, /payment-secrets\/requests/);
  assert.match(ui, /callback-test/);
  assert.match(ui, /无法回显|不可回显/);
  assert.match(ui, /testHistory/);
  assert.match(ui, /run\.actor/);
  assert.match(ui, /run\.reason/);
  assert.match(ui, /\[mainCoinType, setMainCoinType\] = useState\(""\)/);
  assert.match(ui, /!mainCoinType\.trim\(\).*?!tokenCoinType\.trim\(\)/);
  assert.match(ui, /className="rc-hub-tabs"/);
  assert.match(ui, /role="tablist"/);
  assert.match(ui, /role="tab"/);
  assert.match(ui, /aria-selected=\{tab === value\}/);
  assert.match(ui, /onKeyDown=\{event => handleTabKeyDown/);
  assert.doesNotMatch(ui, /className="rc-segmented"/);
  for (const route of [providerTestRoute, callbackTestRoute]) {
    assert.match(route, /runMaintenanceIdempotentExternalCommand/);
    assert.match(route, /recordPaymentProviderTestRun/);
  }
});

test("Operations exposes uncertain address results for manual handling", async () => {
  const [ui, statistics] = await Promise.all([
    read("apps/operations/ui/deposits-workspace.tsx"),
    read("app/api/operations/deposits/statistics/route.operations.ts"),
  ]);
  assert.match(ui, /ADDRESS_PROVISIONING/);
  assert.match(ui, /ADDRESS_UNKNOWN/);
  assert.match(ui, /ADDRESS_FAILED/);
  assert.match(statistics, /ADDRESS_UNKNOWN/);
  assert.match(statistics, /ADDRESS_FAILED/);
});
