import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commercialCustomerScopePredicate,
  operationsCustomerScopeAuthorization,
} from "../lib/commercial-operations-scope.ts";

const identity = { userId: "ops-1", organizationId: "org-a" };
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("commercial predicates preserve assignment-bound customer scopes", () => {
  const direct = commercialCustomerScopePredicate(
    "DIRECT_REPORTS",
    identity,
    "scope_order",
    "o.user_id",
    2,
    ["org-b"],
  );
  assert.match(direct.clause, /customer_attributions/);
  assert.match(direct.clause, /employee_id/);
  assert.deepEqual(direct.values, ["ops-1", ["org-b"]]);

  const team = commercialCustomerScopePredicate(
    "TEAM_TREE",
    identity,
    "scope_order",
    "o.user_id",
    4,
    ["org-a"],
  );
  assert.match(team.clause, /manager_id/);
  assert.match(team.clause, /supervisor_id/);
  assert.match(team.clause, /branch_id/);
  assert.deepEqual(team.values, ["ops-1", ["org-a"]]);

  for (const scope of ["ORGANIZATION", "ORGANIZATION_SET"]) {
    const organization = commercialCustomerScopePredicate(
      scope,
      identity,
      "scope_order",
      "o.user_id",
      1,
      ["org-b"],
    );
    assert.match(organization.clause, /EXISTS/);
    assert.match(organization.clause, /scope_order\.branch_id = ANY\(\$1::text\[\]\)/);
    assert.deepEqual(organization.values, [["org-b"]]);
  }
});

test("mutation authorization binds the live assignment scope to a same-client resolver", async () => {
  const authorize = operationsCustomerScopeAuthorization(
    "ORGANIZATION_SET",
    identity,
    ["org-a"],
  );
  await authorize(
    {
      query: async () => ({
        rows: [{
          customer_id: "customer-a",
          branch_id: "org-a",
          manager_id: null,
          supervisor_id: null,
          employee_id: null,
        }],
      }),
    },
    "customer-a",
  );
  await assert.rejects(
    operationsCustomerScopeAuthorization(
      "ORGANIZATION_SET",
      identity,
      ["org-b"],
    )(
      {
        query: async () => ({
          rows: [{
            customer_id: "customer-a",
            branch_id: "org-a",
            manager_id: null,
            supervisor_id: null,
            employee_id: null,
          }],
        }),
      },
      "customer-a",
    ),
    (error) => error.code === "RESOURCE_NOT_FOUND" && error.status === 404,
  );
});

test("all commercial Operations routes propagate assignment organization ids", async () => {
  for (const path of [
    "app/api/operations/membership-orders/route.operations.ts",
    "app/api/operations/membership-orders/[id]/route.operations.ts",
    "app/api/operations/membership-orders/[id]/decision/route.operations.ts",
    "app/api/operations/membership-orders/[id]/evidence/route.operations.ts",
    "app/api/operations/membership-orders/[id]/submit/route.operations.ts",
    "app/api/operations/performance-statements/route.operations.ts",
    "app/api/operations/performance-statements/generate/route.operations.ts",
    "app/api/operations/performance-statements/[id]/decision/route.operations.ts",
    "app/api/operations/performance-statements/[id]/payment-decision/route.operations.ts",
    "app/api/operations/performance-statements/[id]/payment-evidence/route.operations.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /organizationIds/, `${path} drops assignment scope`);
  }
});

test("commercial Operations mutations inject same-transaction authorization", async () => {
  for (const path of [
    "app/api/operations/membership-orders/[id]/decision/route.operations.ts",
    "app/api/operations/membership-orders/[id]/evidence/route.operations.ts",
    "app/api/operations/membership-orders/[id]/submit/route.operations.ts",
    "app/api/operations/performance-statements/generate/route.operations.ts",
    "app/api/operations/performance-statements/[id]/decision/route.operations.ts",
    "app/api/operations/performance-statements/[id]/payment-decision/route.operations.ts",
    "app/api/operations/performance-statements/[id]/payment-evidence/route.operations.ts",
  ]) {
    const source = await read(path);
    assert.match(
      source,
      /operationsCustomerScopeAuthorization/,
      `${path} does not bind the live scope resolver`,
    );
    assert.match(source, /authorize/, `${path} does not pass authorization to its service`);
  }
});

test("commercial services re-authorize locked customer rows before idempotency", async () => {
  const membership = await read("lib/commercial-membership-service.ts");
  const performance = await read("lib/performance-fee-service.ts");
  const approval = await read("lib/commercial-approval-adapter.ts");

  assert.equal(
    membership.match(/await input\.authorize\?\.\(client, row\.user_id\);/g)?.length,
    3,
    "membership evidence, submit and decision must re-authorize",
  );
  assert.equal(
    performance.match(
      /await input\.authorize\?\.\(client, (?:input\.userId|row\.user_id)\);/g,
    )?.length,
    4,
    "performance generate, assessment, evidence and payment must re-authorize",
  );
  assert.equal(
    approval.match(/authorize:command\.authorize/g)?.length,
    3,
    "the approval adapter must preserve authorization on every command kind",
  );

  for (const source of [membership, performance]) {
    for (const authorization of source.matchAll(/await input\.authorize\?\.\(client, [^)]+\);/g)) {
      const functionStart = source.lastIndexOf("export async function", authorization.index);
      const lockedRow = source.indexOf("FOR UPDATE", functionStart);
      const idempotencyClaim = source.indexOf("claimCommercialIdempotency", functionStart);
      assert.ok(lockedRow > functionStart && lockedRow < authorization.index);
      assert.ok(idempotencyClaim > authorization.index);
    }
  }
});

test("client membership order creation records only the trusted proxy IP", async () => {
  const source = await read("app/api/membership/orders/route.client.ts");
  assert.match(source, /clientIpFromRequest\(request\)/);
  assert.doesNotMatch(source, /headers\.get\(["']x-forwarded-for["']\)/i);
  assert.doesNotMatch(source, /trustedIp:\s*null/);
});
