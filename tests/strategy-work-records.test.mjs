import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { apiPolicyForRoute } from "../lib/api-policy.ts";
import {
  decodeStrategyWorkRecordCursor,
  encodeStrategyWorkRecordCursor,
  parseStrategyWorkRecordListInput,
  strategyWorkRecordEventView,
} from "../lib/strategy-work-records.ts";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("work record list input is bounded and cursors are opaque, validated positions", () => {
  assert.deepEqual(parseStrategyWorkRecordListInput(new URL("https://client.test/api/work-records")), {
    limit: 20,
    cursor: null,
  });
  assert.equal(parseStrategyWorkRecordListInput(new URL("https://client.test/api/work-records?limit=50")).limit, 50);

  const encoded = encodeStrategyWorkRecordCursor({
    occurredAt: "2026-08-24T12:34:56.000Z",
    id: "round:fixture-1",
  });
  assert.doesNotMatch(encoded, /round:fixture-1/);
  assert.deepEqual(decodeStrategyWorkRecordCursor(encoded), {
    occurredAt: "2026-08-24T12:34:56.000Z",
    id: "round:fixture-1",
  });

  for (const url of [
    "https://client.test/api/work-records?limit=0",
    "https://client.test/api/work-records?limit=51",
    "https://client.test/api/work-records?limit=2.5",
    "https://client.test/api/work-records?cursor=not-base64-json",
  ]) {
    assert.throws(
      () => parseStrategyWorkRecordListInput(new URL(url)),
      (error) => error?.code === "VALIDATION_ERROR" && error?.status === 422,
      url,
    );
  }
});

test("work record event projection allowlists evidence and bounds model output", () => {
  const projected = strategyWorkRecordEventView({
    sequence: 5,
    role: "risk",
    conclusion: "结论".repeat(1_500),
    evidence_json: {
      riskState: { drawdownPct: 3, dailyLossPct: 1, consecutiveLosses: 2, halted: false, customerId: "secret-user" },
      rejectionReasons: ["风险原因", "x".repeat(1_000)],
      rawPrompt: "never expose",
    },
    llm_used: true,
    explanation_status: "completed",
    explanation_json: { summary: "解释".repeat(1_500), raw: "private" },
    created_at: new Date("2026-08-24T12:00:00Z"),
  });

  assert.equal(projected.role, "risk_approval");
  assert.equal(projected.conclusion.length, 2_000);
  assert.equal(projected.explanation?.length, 2_000);
  assert.deepEqual(projected.evidence.riskState, {
    drawdownPct: 3,
    dailyLossPct: 1,
    consecutiveLosses: 2,
    halted: false,
  });
  assert.deepEqual(projected.evidence.rejectionReasons, ["风险原因", "x".repeat(500)]);
  assert.doesNotMatch(JSON.stringify(projected), /secret-user|rawPrompt|never expose|private/);
});

test("Client work record routes are permission-scoped, private, and ownership-bound", async () => {
  const [listRoute, detailRoute, followRoute, subscriptionRoute, service, contract, routeContract, migration] = await Promise.all([
    source("../app/api/work-records/route.client.ts"),
    source("../app/api/work-records/[id]/route.client.ts"),
    source("../app/api/platform-strategies/[code]/follow/route.client.ts"),
    source("../app/api/platform-strategy-subscriptions/[id]/route.client.ts"),
    source("../lib/strategy-work-records.ts"),
    source("../packages/contracts/src/strategy-work-records.ts"),
    source("../app/riverton-route-contract.ts"),
    source("../postgres/migrations/0075_strategy_work_record_retention.sql"),
  ]);

  assert.match(listRoute, /requireAccessPermission\(request,\s*"client\.paper\.view"\)/);
  assert.match(detailRoute, /requireAccessPermission\(request,\s*"client\.paper\.view"\)/);
  assert.match(listRoute, /private, no-store, max-age=0/i);
  assert.match(detailRoute, /private, no-store, max-age=0/i);
  assert.match(service, /period\.customer_id\s*=\s*\$1/);
  assert.match(service, /deployment\.owner_user_id\s*=\s*\$1/);
  assert.match(service, /period\.started_at/);
  assert.match(service, /period\.ended_at/);
  assert.match(service, /round\.strategy_version_id\s*=\s*period\.strategy_version_id/);
  assert.match(service, /SET LOCAL statement_timeout='5s'/);
  assert.match(service, /WORK_RECORD_NOT_FOUND/);
  assert.match(contract, /realOrderRoutingEnabled:\s*false/);
  assert.match(routeContract, /"work-records"/);
  assert.match(followRoute, /INSERT INTO strategy_subscription_periods/);
  assert.match(followRoute, /switched\.endedDeploymentIds/);
  assert.match(subscriptionRoute, /action === "stop"[\s\S]*UPDATE strategy_subscription_periods/);
  assert.match(subscriptionRoute, /pg_advisory_xact_lock[\s\S]*platform-follow:/);
  assert.match(migration, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(migration, /missing migration map/);
  assert.match(migration, /facts are inconsistent/);
  assert.match(migration, /cannot overlap/);
  assert.match(migration, /idx_official_paper_intents_runtime_cycle/);

  for (const route of ["/api/work-records", "/api/work-records/:id"]) {
    const policy = apiPolicyForRoute(route, "GET");
    assert.deepEqual(policy.audiences, ["client"]);
    assert.equal(policy.authentication, "permission");
    assert.deepEqual(policy.permissionKeys, ["client.paper.view"]);
  }
});
