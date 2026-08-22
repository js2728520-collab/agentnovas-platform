import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("operations data scopes never widen team access to the whole organization", async () => {
  const { customerScopePredicate } = await import("../lib/operations-access.ts");
  const identity = { userId: "user-1", organizationId: "org-1" };
  assert.match(customerScopePredicate("SELF", identity, "d", "d.user_id").clause, /d\.user_id/);
  assert.match(customerScopePredicate("DIRECT_REPORTS", identity, "d", "d.user_id").clause, /employee_id/);
  const team = customerScopePredicate("TEAM_TREE", identity, "d", "d.user_id");
  assert.match(team.clause, /manager_id/);
  assert.match(team.clause, /supervisor_id/);
  assert.doesNotMatch(team.clause, /^d\.branch_id/);
  assert.match(customerScopePredicate("ORGANIZATION", identity, "d", "d.user_id").clause, /d\.branch_id/);
});

test("RBAC list endpoints are bound to the current application audience", async () => {
  for (const path of [
    "app/api/access/roles/route.internal.ts",
    "app/api/access/role-templates/route.internal.ts",
    "app/api/access/assignments/route.internal.ts",
    "app/api/access/audit/route.internal.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /applicationId|appId/);
    assert.match(source, /WHERE|where/i);
  }
  const changes = await read("app/api/access/change-requests/route.internal.ts");
  assert.match(changes, /export async function GET/);
  assert.match(changes, /status/);
});

test("operations exposes scoped action queues, normalized deposit details and immutable ledger", async () => {
  const queue = await read("app/api/operations/deposit-action-requests/route.operations.ts");
  const detail = await read("app/api/operations/deposits/[id]/route.operations.ts");
  const ledger = await read("app/api/operations/ledger/route.operations.ts");
  assert.match(queue, /ops\.deposits\.action_approve/);
  assert.match(queue, /customerScopePredicate/);
  assert.match(detail, /canRevealPii/);
  assert.match(detail, /actionRequests/);
  assert.match(ledger, /ops\.ledger\.view/);
  assert.match(ledger, /cursor/);
  assert.match(ledger, /postings/);
});

test("finance workspace uses commercial orders, Paper fee statements and immutable ledger", async () => {
  const finance = await read("apps/operations/ui/finance-workspace.tsx");
  assert.match(finance, /operations\/membership-orders/);
  assert.match(finance, /operations\/performance-statements/);
  assert.match(finance, /operations\/ledger/);
  assert.match(finance, /EmptyState/);
  assert.doesNotMatch(finance, /payout-profiles|finance\/adjustments/);
});

test("RBAC viewers, assignees and reviewers are authorized independently", async () => {
  const access = await read("lib/access-control.ts");
  const decisions = await read("app/api/access/change-requests/[id]/decisions/route.internal.ts");
  const revoke = await read("app/api/access/assignments/[id]/route.internal.ts");
  assert.match(access, /requireCurrentAccessViewer/);
  assert.match(access, /requireCurrentAccessAssignmentAdmin/);
  assert.match(access, /requireCurrentAccessReviewer/);
  assert.match(decisions, /requireCurrentAccessReviewer/);
  assert.doesNotMatch(decisions, /审批人不具备该应用的角色管理权限/);
  assert.match(revoke, /角色撤销必须提交权限变更申请/);
  assert.doesNotMatch(revoke, /UPDATE user_role_assignments/);
  assert.match(await read("app/api/access/change-requests/route.internal.ts"), /必须填写权限变更原因/);
});
