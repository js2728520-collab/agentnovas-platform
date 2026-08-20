import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root=new URL("../",import.meta.url);
const exists=async path=>{try{await access(new URL(path,root));return true;}catch{return false;}};

test("commercial APIs use only the locked public route surface",async()=>{
  for(const path of [
    "app/api/membership/plans/route.ts","app/api/membership/me/route.ts","app/api/membership/orders/route.ts",
    "app/api/membership/performance-statements/route.ts","app/api/credits/me/route.ts",
    "app/api/operations/membership-orders/route.ts","app/api/operations/performance-statements/route.ts",
  ])assert.equal(await exists(path),true,`missing ${path}`);
  for(const path of ["app/api/client/plans/route.ts","app/api/client/membership/orders/route.ts","app/api/operations/membership/orders/route.ts"])
    assert.equal(await exists(path),false,`obsolete route remains ${path}`);
});

test("commercial routes use dedicated frozen permissions and header idempotency",async()=>{
  const files=[
    "app/api/membership/orders/route.ts","app/api/operations/membership-orders/route.ts",
    "app/api/operations/performance-statements/route.ts","lib/commercial-api.ts",
    "lib/commercial-request-validation.ts",
  ];
  const source=(await Promise.all(files.map(file=>readFile(new URL(file,root),"utf8")))).join("\n");
  for(const key of ["client.membership.order","ops.membership_orders.view","ops.performance_fees.view"])
    assert.ok(source.includes(key),`missing permission ${key}`);
  assert.doesNotMatch(source,/client\.wallet|ops\.ledger|ops\.reconciliation/);
  assert.match(source,/Idempotency-Key/i);
});

test("plan, currencies and seven-part legal contract are release locked",async()=>{
  const sql=await readFile(new URL("postgres/migrations/0023_commercial_membership_settlement.sql",root),"utf8");
  for(const code of ["monthly_v1","quarterly_v1","annual_v1","lifetime_v1"])
    assert.ok(sql.includes(code),`missing ${code}`);
  for(const legal of ["service_entity","jurisdiction","privacy","terms","risk_disclosure","simulated_performance_fee_opinion","refund_policy"])
    assert.ok(sql.includes(legal),`missing ${legal}`);
  assert.match(sql,/price_currency[^\n]+DEFAULT 'USD'/i);
  assert.match(sql,/currency[^\n]+DEFAULT 'USDT'/i);
});

test("ledger closes posting window when transaction is committed",async()=>{
  const sql=await readFile(new URL("postgres/migrations/0022_ledger_approval_invariants.sql",root),"utf8");
  assert.match(sql,/LEDGER_TRANSACTION_COMMITTED/);
  assert.match(sql,/status[^\n]+pending[^\n]+posted/i);
});

test("performance generation accepts no caller-selected strategy scope",async()=>{
  const route=await readFile(new URL("app/api/operations/performance-statements/generate/route.ts",root),"utf8");
  assert.doesNotMatch(route,/strategyIds|stringArray|weekStart|weekEnd/);
  const boundary=await readFile(new URL("lib/commercial-portfolio-scope.ts",root),"utf8");
  assert.match(boundary,/OfficialThreeCardPortfolioScopeResolver/);
  assert.match(boundary,/NOT_CONFIGURED/);
});
