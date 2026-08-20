import assert from "node:assert/strict";
import test from "node:test";

import {
  accessOrganizationResourcePredicate,
  accessPageCursor,
  canAccessInternalUser,
  parseAccessPageCursor,
  scopeCanDelegate,
} from "../lib/access-center-scope.ts";

const people = [
  { id: "root", organizationId: "org-a", reportsToUserId: null },
  { id: "manager", organizationId: "org-a", reportsToUserId: "root" },
  { id: "employee", organizationId: "org-a", reportsToUserId: "manager" },
  { id: "outsider", organizationId: "org-b", reportsToUserId: null },
];

test("Access Center scopes cannot enumerate users outside the effective grant", () => {
  assert.equal(canAccessInternalUser("ORGANIZATION_SET", { id: "root", organizationId: "org-a" }, people[2], people, ["org-a"]), true);
  assert.equal(canAccessInternalUser("ORGANIZATION_SET", { id: "root", organizationId: "org-a" }, people[3], people, ["org-a"]), false);
  assert.equal(canAccessInternalUser("DIRECT_REPORTS", { id: "root", organizationId: "org-a" }, people[1], people), true);
  assert.equal(canAccessInternalUser("DIRECT_REPORTS", { id: "root", organizationId: "org-a" }, people[2], people), false);
  assert.equal(canAccessInternalUser("TEAM_TREE", { id: "root", organizationId: "org-a" }, people[2], people), true);
  assert.equal(canAccessInternalUser("TEAM_TREE", { id: "manager", organizationId: "org-a" }, people[0], people), false);
});

test("delegation cannot grant a broader role scope", () => {
  assert.equal(scopeCanDelegate("ORGANIZATION", "ORGANIZATION"), true);
  assert.equal(scopeCanDelegate("ORGANIZATION_SET", "ORGANIZATION"), true);
  assert.equal(scopeCanDelegate("TEAM_TREE", "ORGANIZATION"), false);
  assert.equal(scopeCanDelegate("ORGANIZATION", "PLATFORM"), false);
  assert.equal(scopeCanDelegate("PLATFORM", "PLATFORM"), true);
});

test("Access Center cursor is opaque, bounded, and round trips a stable tie-breaker", () => {
  const cursor = accessPageCursor({ createdAt: "2026-08-20T12:00:00.000Z", id: "assignment-1" });
  assert.deepEqual(parseAccessPageCursor(cursor), { createdAt: "2026-08-20T12:00:00.000Z", id: "assignment-1" });
  assert.throws(() => parseAccessPageCursor("not-base64"));
  assert.throws(() => parseAccessPageCursor("x".repeat(1025)));
});

test("organization resource predicates fence every owner and applies-to dimension", () => {
  assert.deepEqual(accessOrganizationResourcePredicate({
    scope: "ORGANIZATION_SET",
    actor: { id: "root", organizationId: "org-a" },
    organizationIds: ["org-a"],
    columns: ["r.created_organization_id", "r.applies_to_organization_id"],
    startIndex: 2,
  }), {
    clause: "(r.created_organization_id IS NULL OR r.created_organization_id = ANY($2::text[])) AND (r.applies_to_organization_id IS NULL OR r.applies_to_organization_id = ANY($2::text[]))",
    values: [["org-a"]],
  });
  assert.throws(() => accessOrganizationResourcePredicate({
    scope: "ORGANIZATION",
    actor: { id: "root", organizationId: "org-a" },
    organizationIds: [],
    columns: ["r.created_organization_id; DROP TABLE roles"],
    startIndex: 1,
  }));
});
