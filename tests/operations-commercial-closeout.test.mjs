import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("operations finance uses the commercial Paper contract and exposes no legacy payment mutations", async () => {
  const [workspace, generator] = await Promise.all([
    read("apps/operations/ui/finance-workspace.tsx"),
    read("scripts/generate-api-route-inventory.mjs"),
  ]);
  assert.match(workspace, /\/api\/operations\/membership-orders/);
  assert.match(workspace, /\/api\/operations\/performance-statements/);
  assert.match(workspace, /\/api\/operations\/ledger/);
  assert.doesNotMatch(workspace, /\/api\/finance\/(?:settlements|collections|payout-profiles|adjustments)/);
  assert.doesNotMatch(workspace, /address|txHash|network/i);
  for (const route of [
    "GET /api/finance/collections",
    "GET /api/finance/payout-profiles",
    "GET /api/finance/settlements",
    "POST /api/finance/adjustments",
    "POST /api/finance/collections/:id/confirm-paid",
    "POST /api/finance/collections/refresh",
    "POST /api/finance/payout-profiles",
    "POST /api/finance/settlements",
    "POST /api/finance/settlements/:id/paid",
  ]) assert.match(generator, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(generator, /authentication: "disabled"/);
});

test("internal member lifecycle is bounded, scoped, audited and session revoking", async () => {
  const [route, workspace] = await Promise.all([
    read("app/api/organization/members/[id]/status/route.ts"),
    read("apps/operations/ui/organization-workspace.tsx"),
  ]);
  assert.match(route, /readResearchJson\(request, 4_096\)/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /canAccessOrganization/);
  assert.match(route, /UPDATE sessions SET revoked_at/);
  assert.match(route, /organization\.member_(?:deactivated|restored)/);
  assert.match(workspace, /停用成员/);
  assert.match(workspace, /恢复成员/);
  assert.match(workspace, /重新发送邀请/);
});

test("unified approvals project commercial and organization queues without community governance", async () => {
  const [workspace, decision] = await Promise.all([
    read("apps/operations/ui/approvals-workspace.tsx"),
    read("app/api/approvals/[id]/decision/route.ts"),
  ]);
  assert.match(workspace, /membership-orders\?status=SUBMITTED/);
  assert.match(workspace, /performance-statements\?status=SUBMITTED/);
  assert.match(workspace, /performance-statements\?status=INVOICED/);
  assert.match(workspace, /\/api\/approvals/);
  assert.doesNotMatch(workspace, /community|strategy_listing/i);
  assert.match(decision, /reporting_line_change/);
  assert.match(decision, /FOR UPDATE/);
  assert.doesNotMatch(decision, /communityStrategies|revenueEvents|payoutProfiles|settlements|collectionCases/);
});
