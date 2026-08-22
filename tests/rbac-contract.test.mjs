import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DATA_SCOPES,
  PERMISSION_DEFINITIONS,
  SENSITIVE_PERMISSION_KEYS,
  canApproveAccessChange,
  effectivePermissionMap,
  legacyRoleAssignments,
  validateDerivedRolePermissions,
} from "../lib/rbac.ts";
import { parseAccessChangeRequest } from "../lib/access-change-requests.ts";
import { ResearchApiError } from "../lib/research-errors.ts";

test("registers fixed permissions and bounded data scopes for all three apps", () => {
  assert.deepEqual(DATA_SCOPES, ["SELF", "DIRECT_REPORTS", "TEAM_TREE", "ORGANIZATION", "ORGANIZATION_SET", "PLATFORM"]);
  for (const key of [
    "client.deposit.create",
    "ops.deposits.action_approve",
    "ops.deposits.pii_reveal",
    "maint.email_integrations.manage",
    "maint.emergency_pause.execute",
  ]) {
    assert.ok(PERMISSION_DEFINITIONS.some((permission) => permission.key === key), key);
  }
});

test("derived branch roles can only reduce template permissions and scopes", () => {
  const template = [
    { permissionKey: "ops.deposits.view", scope: "ORGANIZATION" },
    { permissionKey: "ops.deposits.export", scope: "ORGANIZATION" },
  ];
  assert.equal(validateDerivedRolePermissions(template, [
    { permissionKey: "ops.deposits.view", scope: "TEAM_TREE" },
  ]).ok, true);
  assert.deepEqual(validateDerivedRolePermissions(template, [
    { permissionKey: "ops.deposits.view", scope: "PLATFORM" },
  ]), {
    ok: false,
    code: "SCOPE_ESCALATION",
    permissionKey: "ops.deposits.view",
  });
  assert.deepEqual(validateDerivedRolePermissions(template, [
    { permissionKey: "ops.roles.manage", scope: "ORGANIZATION" },
  ]), {
    ok: false,
    code: "PERMISSION_NOT_IN_TEMPLATE",
    permissionKey: "ops.roles.manage",
  });
});

test("sensitive permissions require maker-checker and never allow self approval", () => {
  assert.ok(SENSITIVE_PERMISSION_KEYS.has("ops.deposits.action_approve"));
  assert.deepEqual(canApproveAccessChange({
    requesterUserId: "u1",
    approverUserId: "u1",
    approverPermissionKeys: ["ops.roles.approve_sensitive"],
    requestedPermissionKeys: ["ops.deposits.action_approve"],
  }), { ok: false, code: "SELF_APPROVAL_FORBIDDEN" });
  assert.deepEqual(canApproveAccessChange({
    requesterUserId: "u1",
    approverUserId: "u2",
    approverPermissionKeys: ["ops.deposits.view"],
    requestedPermissionKeys: ["ops.deposits.action_approve"],
  }), { ok: false, code: "APPROVER_LACKS_SENSITIVE_APPROVAL" });
  assert.deepEqual(canApproveAccessChange({
    requesterUserId: "u1",
    approverUserId: "u2",
    approverPermissionKeys: ["ops.roles.approve_sensitive"],
    requestedPermissionKeys: ["ops.deposits.action_approve"],
  }), { ok: true });
});

test("legacy roles map into app-specific assignments and effective permission unions", () => {
  assert.ok(legacyRoleAssignments("hq_admin").some((assignment) => assignment.appId === "maintenance"));
  const effective = effectivePermissionMap([
    { permissionKey: "ops.deposits.view", scope: "ORGANIZATION" },
    { permissionKey: "ops.deposits.view", scope: "PLATFORM" },
    { permissionKey: "ops.deposits.export", scope: "ORGANIZATION" },
  ]);
  assert.deepEqual(effective, {
    "ops.deposits.export": "ORGANIZATION",
    "ops.deposits.view": "PLATFORM",
  });
});

test("typed access changes reject unsafe keys and normalize bounded expiry", () => {
  const validExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const change = parseAccessChangeRequest({
    applicationId: "operations",
    changeType: "role_assign",
    targetUserId: "user-1",
    targetRoleId: "role-1",
    before: {},
    after: { expiresAt: validExpiry, reason: "temporary" },
  });
  assert.equal(change.after.expiresAt, validExpiry);
  assert.throws(() => parseAccessChangeRequest({
    applicationId: "operations", changeType: "role_create", before: {},
    after: { code: "x", name: "x", permissions: [], isSystem: true },
  }), (error) => error instanceof ResearchApiError && error.status === 422);
  assert.throws(() => parseAccessChangeRequest({
    applicationId: "operations", changeType: "role_assign", targetUserId: "u", targetRoleId: "r", before: {},
    after: { expiresAt: "2099-01-01T00:00:00.000Z", reason: "x" },
  }), (error) => error instanceof ResearchApiError && error.status === 422);
});

test("decision route locks request, applies mutations, and audits in transaction", async () => {
  const source = await readFile(new URL("../app/api/access/change-requests/[id]/decisions/route.ts", import.meta.url), "utf8");
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /applyApprovedChange/);
  assert.match(source, /authorization_audit_events/);
  assert.match(source, /ON CONFLICT \(request_id, reviewer_user_id\) DO NOTHING/);
  assert.match(source, /canApproveAccessChange/);
});

test("role assignment endpoint refuses direct sensitive grants", async () => {
  const source = await readFile(new URL("../app/api/access/assignments/route.ts", import.meta.url), "utf8");
  assert.match(source, /SENSITIVE_APPROVAL_REQUIRED/);
  assert.match(source, /pd\.sensitive = true/);
});
