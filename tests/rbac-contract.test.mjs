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

test("role assignment endpoint refuses direct sensitive grants", async () => {
  const source = await readFile(new URL("../app/api/access/assignments/route.ts", import.meta.url), "utf8");
  assert.match(source, /SENSITIVE_APPROVAL_REQUIRED/);
  assert.match(source, /pd\.sensitive = true/);
});
