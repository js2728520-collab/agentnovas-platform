import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveEffectiveAccess } from "../lib/effective-access.ts";
import { customerScopePredicate } from "../lib/operations-access.ts";

test("internal applications never fall back to legacy roles without explicit assignments", () => {
  const access = resolveEffectiveAccess({
    appId: "maintenance",
    legacyRole: "hq_admin",
    hasAnyAssignment: false,
    hasRevocationTombstone: false,
    rows: [],
  });
  assert.deepEqual(access, { source: "rbac", permissions: {}, grants: {} });
});

test("a revoked or tombstoned client assignment never restores legacy permissions", () => {
  for (const state of [
    { hasAnyAssignment: true, hasRevocationTombstone: false },
    { hasAnyAssignment: false, hasRevocationTombstone: true },
  ]) {
    const access = resolveEffectiveAccess({ appId: "client", legacyRole: "customer", rows: [], ...state });
    assert.deepEqual(access, { source: "rbac", permissions: {}, grants: {} });
  }
  const compatibility = resolveEffectiveAccess({
    appId: "client",
    legacyRole: "customer",
    hasAnyAssignment: false,
    hasRevocationTombstone: false,
    rows: [],
  });
  assert.equal(compatibility.source, "legacy_role");
  assert.equal(compatibility.permissions["client.wallet.view"], "SELF");
});

test("effective RBAC grants intersect role and assignment organization bounds", () => {
  const access = resolveEffectiveAccess({
    appId: "operations",
    legacyRole: "hq_admin",
    hasAnyAssignment: true,
    hasRevocationTombstone: false,
    rows: [
      {
        permissionKey: "ops.deposits.view",
        scope: "ORGANIZATION_SET",
        assignmentOrganizationId: "org-a",
        assignmentOrganizationIds: ["org-a", "org-b"],
        permissionOrganizationIds: ["org-b", "org-c"],
      },
      {
        permissionKey: "ops.deposits.view",
        scope: "ORGANIZATION",
        assignmentOrganizationId: "org-d",
        assignmentOrganizationIds: [],
        permissionOrganizationIds: [],
      },
    ],
  });
  assert.deepEqual(access.permissions, { "ops.deposits.view": "ORGANIZATION_SET" });
  assert.deepEqual(access.grants["ops.deposits.view"], {
    scope: "ORGANIZATION_SET",
    organizationIds: ["org-b", "org-d"],
  });
});

test("organization-set predicates use assignment-bound ids instead of the viewer organization", () => {
  const result = customerScopePredicate(
    "ORGANIZATION_SET",
    { userId: "user-1", organizationId: "viewer-org" },
    "d",
    "d.user_id",
    3,
    ["org-a", "org-b"],
  );
  assert.match(result.clause, /d\.branch_id = ANY\(\$3::text\[\]\)/);
  assert.deepEqual(result.values, [["org-a", "org-b"]]);
});

test("approved assignment changes maintain explicit revocation tombstones", async () => {
  const decisions = await readFile(new URL("../app/api/access/change-requests/[id]/decisions/route.internal.ts", import.meta.url), "utf8");
  const directAssignments = await readFile(new URL("../app/api/access/assignments/route.internal.ts", import.meta.url), "utf8");
  assert.match(decisions, /INSERT INTO rbac_revocation_tombstones/);
  assert.match(decisions, /ON CONFLICT \(user_id, application_id\)/);
  assert.match(decisions, /DELETE FROM rbac_revocation_tombstones/);
  assert.match(directAssignments, /DELETE FROM rbac_revocation_tombstones/);
});
