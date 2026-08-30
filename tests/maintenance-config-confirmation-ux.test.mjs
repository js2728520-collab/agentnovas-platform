import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("ordinary Maintenance configuration uses server-owned audit without confirmation dialogs", async () => {
  for (const path of [
    "apps/maintenance/ui/platform-settings-workspace.tsx",
    "apps/maintenance/ui/email-integration-workspace.tsx",
    "apps/maintenance/ui/source-integrations-workspace.tsx",
  ]) {
    const sharedEmailControls = path.endsWith("email-integration-workspace.tsx")
      ? await Promise.all([
        read("packages/ui/src/email-service-manager/email-service-configuration.tsx"),
        read("packages/ui/src/email-service-manager/email-service-tests.tsx"),
      ]).then((parts) => parts.join("\n"))
      : "";
    const source = `${await read(path)}\n${sharedEmailControls}`;
    assert.doesNotMatch(source, /InlineAuditReasonField|hasValidAuditReason|auditReason/);
    assert.doesNotMatch(source, /ConfirmActionDialog/);
  }
});

test("Maintenance configuration and control actions stay inline without audit prose or modal confirmations", async () => {
  for (const path of [
    "apps/maintenance/ui/models-workspace.tsx",
    "apps/maintenance/ui/payment-integration-workspace.tsx",
    "apps/maintenance/ui/commercial-disclosures-workspace.tsx",
    "apps/maintenance/ui/demo-exchanges-workspace.tsx",
    "apps/maintenance/ui/release-management-workspace.tsx",
    "apps/maintenance/ui/emergency-control-workspace.tsx",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /InlineAuditReasonField|hasValidAuditReason/);
    assert.doesNotMatch(source, /ConfirmActionDialog/);
    assert.doesNotMatch(source, /<dialog/);
  }
});

test("integration and model controls retain busy guards without manual audit reasons", async () => {
  const models = await read("apps/maintenance/ui/models-workspace.tsx");
  assert.doesNotMatch(models, /本轮配置原因|hasValidAuditReason|reason:\s*reason/);
  assert.match(models, /disabled=\{busy/);

  const payment = await read("apps/maintenance/ui/payment-integration-workspace.tsx");
  assert.doesNotMatch(payment, /启停原因|statusReason|hasValidAuditReason/);
  assert.match(payment, /disabled=\{busy/);

  const demo = await read("apps/maintenance/ui/demo-exchanges-workspace.tsx");
  assert.doesNotMatch(demo, /安全控制原因|controlReason|hasValidAuditReason/);
  assert.match(demo, /disabled=\{busy/);
});

test("publishing controls use automatic audit while emergency keeps a business incident note", async () => {
  const disclosures = await read("apps/maintenance/ui/commercial-disclosures-workspace.tsx");
  assert.doesNotMatch(disclosures, /提交原因|复核原因|InlineAuditReasonField/);

  const releases = await read("apps/maintenance/ui/release-management-workspace.tsx");
  assert.doesNotMatch(releases, /版本操作原因|auditReason|InlineAuditReasonField/);

  const emergency = await read("apps/maintenance/ui/emergency-control-workspace.tsx");
  assert.match(emergency, /事故或处置说明（业务字段）/);
  assert.doesNotMatch(emergency, /InlineAuditReasonField|hasValidAuditReason/);
  assert.match(emergency, /"idempotency-key": commandKey\.current/);
  assert.match(emergency, /commandKey\.current = crypto\.randomUUID\(\)/);
});
