import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("ordinary Maintenance configuration uses an inline audit reason without confirmation dialogs", async () => {
  for (const path of [
    "apps/maintenance/ui/platform-settings-workspace.tsx",
    "apps/maintenance/ui/email-integration-workspace.tsx",
    "apps/maintenance/ui/source-integrations-workspace.tsx",
  ]) {
    const source = await read(path);
    assert.match(source, /InlineAuditReasonField/);
    assert.doesNotMatch(source, /ConfirmActionDialog/);
  }
});

test("model configuration and connectivity are direct while rollback remains confirmed", async () => {
  const source = await read("apps/maintenance/ui/models-workspace.tsx");
  assert.match(source, /InlineAuditReasonField/);
  assert.match(source, /pendingRollback/);
  assert.match(source, /ConfirmActionDialog/);
  assert.match(source, /open=\{Boolean\(pendingRollback\)\}/);
  assert.doesNotMatch(source, /setPending\(\{ kind: "(?:profile|binding|test)"/);
});

test("payment mapping and tests are direct while channel activation remains confirmed", async () => {
  const source = await read("apps/maintenance/ui/payment-integration-workspace.tsx");
  assert.match(source, /InlineAuditReasonField/);
  assert.match(source, /type PendingStatusCommand = \{ provider: MaintenancePaymentProvider; kind: "activate" \| "disable" \}/);
  assert.match(source, /submitDirect\(provider, "configure"\)/);
  assert.match(source, /submitDirect\(provider, "test"\)/);
  assert.match(source, /ConfirmActionDialog/);
});

test("Demo connectivity verification is direct while safety controls remain confirmed", async () => {
  const source = await read("apps/maintenance/ui/demo-exchanges-workspace.tsx");
  assert.match(source, /InlineAuditReasonField/);
  assert.match(source, /verifyAccount\(account\)/);
  assert.doesNotMatch(source, /queueAction\(\{ account, action: "verify" \}\)/);
  assert.match(source, /ConfirmActionDialog/);
});
