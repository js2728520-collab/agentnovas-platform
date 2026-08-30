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
    const sharedEmailControls = path.endsWith("email-integration-workspace.tsx")
      ? await read("packages/ui/src/email-service-manager/email-service-configuration.tsx")
      : "";
    const source = `${await read(path)}\n${sharedEmailControls}`;
    assert.match(source, /InlineAuditReasonField/);
    assert.doesNotMatch(source, /ConfirmActionDialog/);
  }
});

test("Maintenance configuration and control actions stay inline without modal confirmations", async () => {
  for (const path of [
    "apps/maintenance/ui/models-workspace.tsx",
    "apps/maintenance/ui/payment-integration-workspace.tsx",
    "apps/maintenance/ui/commercial-disclosures-workspace.tsx",
    "apps/maintenance/ui/demo-exchanges-workspace.tsx",
    "apps/maintenance/ui/release-management-workspace.tsx",
    "apps/maintenance/ui/emergency-control-workspace.tsx",
  ]) {
    const source = await read(path);
    assert.match(source, /InlineAuditReasonField/);
    assert.match(source, /hasValidAuditReason/);
    assert.doesNotMatch(source, /ConfirmActionDialog/);
    assert.doesNotMatch(source, /<dialog/);
  }
});

test("integration and model controls retain explicit inline reasons and busy guards", async () => {
  const models = await read("apps/maintenance/ui/models-workspace.tsx");
  assert.match(models, /回滚原因/);
  assert.match(models, /hasValidAuditReason\(rollbackReason\)/);

  const payment = await read("apps/maintenance/ui/payment-integration-workspace.tsx");
  assert.match(payment, /启停原因/);
  assert.match(payment, /hasValidAuditReason\(statusReason\)/);

  const demo = await read("apps/maintenance/ui/demo-exchanges-workspace.tsx");
  assert.match(demo, /安全控制原因/);
  assert.match(demo, /hasValidAuditReason\(controlReason,\s*8\)/);
});

test("publishing and emergency controls retain explicit inline reasons", async () => {
  const disclosures = await read("apps/maintenance/ui/commercial-disclosures-workspace.tsx");
  assert.match(disclosures, /提交原因/);
  assert.match(disclosures, /复核原因/);

  const releases = await read("apps/maintenance/ui/release-management-workspace.tsx");
  assert.match(releases, /版本操作原因/);

  const emergency = await read("apps/maintenance/ui/emergency-control-workspace.tsx");
  assert.match(emergency, /审批或事故原因/);
  assert.match(emergency, /hasValidAuditReason\(reason\)/);
  assert.match(emergency, /"idempotency-key": commandKey\.current/);
  assert.match(emergency, /commandKey\.current = crypto\.randomUUID\(\)/);
});
