import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("server generates bounded automatic audit markers from an allowlisted action", async () => {
  const { automaticAuditReason } = await import("../lib/maintenance-audit.ts");

  assert.equal(
    automaticAuditReason("ai_control_plane.configuration.save"),
    "automatic:ai_control_plane.configuration.save",
  );
  assert.throws(() => automaticAuditReason("bad action\nforged"), /自动审计动作无效/);
  assert.throws(() => automaticAuditReason(""), /自动审计动作无效/);
});

test("automatic Maintenance audit rows identify their trusted source", async () => {
  const source = await read("lib/maintenance-audit.ts");
  assert.doesNotMatch(source, /export function maintenanceReason/);
  assert.match(source, /const reason = automaticAuditReason\(input\.action\)/);
  assert.doesNotMatch(source, /reason:\s*string;/);
  assert.match(source, /auditSource:\s*"automatic"/);
  assert.match(source, /action:\s*input\.action/);
});

test("AI control-plane UI has no manual audit reason or reason-gated actions", async () => {
  const source = await read("apps/maintenance/ui/models-workspace.tsx");
  assert.doesNotMatch(source, /InlineAuditReasonField|hasValidAuditReason/);
  assert.doesNotMatch(source, /配置与测试原因|本轮配置原因/);
  assert.doesNotMatch(source, /reason:\s*reason\.trim\(\)/);
  assert.doesNotMatch(source, /!hasValidAuditReason/);
});

test("all generic inline audit reason controls are retired", async () => {
  for (const path of [
    "apps/maintenance/ui/commercial-disclosures-workspace.tsx",
    "apps/maintenance/ui/configuration-version-create-panel.tsx",
    "apps/maintenance/ui/configuration-version-detail-panel.tsx",
    "apps/maintenance/ui/demo-exchanges-workspace.tsx",
    "apps/maintenance/ui/email-integration-workspace.tsx",
    "apps/maintenance/ui/emergency-control-workspace.tsx",
    "apps/maintenance/ui/models-workspace.tsx",
    "apps/maintenance/ui/payment-integration-workspace.tsx",
    "apps/maintenance/ui/platform-settings-workspace.tsx",
    "apps/maintenance/ui/release-management-workspace.tsx",
    "apps/maintenance/ui/restricted-cicd-workspace.tsx",
    "apps/maintenance/ui/source-integrations-workspace.tsx",
    "packages/ui/src/access-center.tsx",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /InlineAuditReasonField|hasValidAuditReason/, path);
  }
  await assert.rejects(
    access(new URL("../packages/ui/src/inline-audit-reason-field.tsx", import.meta.url)),
  );
});

test("ordinary organization, account, and export actions do not request audit prose", async () => {
  for (const path of [
    "apps/operations/ui/organization-workspace.tsx",
    "apps/operations/ui/accounts-workspace.tsx",
    "apps/maintenance/ui/work-record-export-workspace.tsx",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /auditReason|审计原因/, path);
  }
});

test("confirmation dialogs request prose only when the caller names a business field", async () => {
  const source = await read("packages/ui/src/confirm-action-dialog.tsx");
  assert.match(source, /reasonLabel\?:\s*string/);
  assert.match(source, /reasonLabel\s*\?\s*<label>/);
  assert.doesNotMatch(source, /reasonLabel\s*=\s*["'].*审计/);
  assert.doesNotMatch(source, /disabled=\{busy\s*\|\|\s*!reason\.trim/);
});

test("access, session, and MFA controls rely on server-owned audit actions", async () => {
  for (const path of [
    "app/api/access/assignments/route.internal.ts",
    "app/api/access/change-requests/route.internal.ts",
    "app/api/access/change-requests/[id]/decisions/route.internal.ts",
    "app/api/access/roles/[id]/publish/route.internal.ts",
    "app/api/account/sessions/route.shared.ts",
    "app/api/auth/mfa/recovery-codes/route.shared.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /automaticAuditReason\(/, path);
    assert.doesNotMatch(source, /body\.reason/, path);
  }
  for (const path of [
    "packages/ui/src/access-center.tsx",
    "apps/client/ui/account-security-workspace.tsx",
    "packages/ui/src/internal-account-security.tsx",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /reason:\s*[A-Za-z_$]|setAuditReason|setReason/, path);
  }
});

test("generic Maintenance mutation routes derive audit markers at the trusted boundary", async () => {
  for (const path of [
    "app/api/maintenance/platform-settings/route.maintenance.ts",
    "app/api/maintenance/email/test/route.maintenance.ts",
    "app/api/maintenance/integrations/[id]/test/route.maintenance.ts",
    "app/api/maintenance/payment-providers/[id]/configuration/route.maintenance.ts",
    "app/api/maintenance/payment-providers/[id]/status/route.maintenance.ts",
    "app/api/maintenance/payment-providers/[id]/test/route.maintenance.ts",
    "app/api/maintenance/demo-exchanges/[id]/verify/route.maintenance.ts",
    "app/api/maintenance/demo-exchanges/[id]/control/route.maintenance.ts",
    "app/api/maintenance/releases/route.maintenance.ts",
    "app/api/maintenance/releases/[id]/verification/route.maintenance.ts",
    "app/api/maintenance/releases/[id]/deployments/route.maintenance.ts",
    "app/api/maintenance/configuration-versions/route.maintenance.ts",
    "app/api/maintenance/configuration-versions/[id]/tests/route.maintenance.ts",
    "app/api/maintenance/configuration-versions/[id]/approval/route.maintenance.ts",
    "app/api/maintenance/configuration-versions/[id]/schedule/route.maintenance.ts",
    "app/api/maintenance/configuration-versions/[id]/activation/route.maintenance.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /(?:automaticAuditReason|recordMaintenanceAudit)\(/, path);
    assert.doesNotMatch(source, /body\.reason/, path);
  }
});

test("AI control-plane APIs ignore legacy reason text and use server-owned actions", async () => {
  for (const path of [
    "app/api/maintenance/ai-control-plane/configurations/route.maintenance.ts",
    "app/api/maintenance/ai-control-plane/deployments/[id]/revisions/route.maintenance.ts",
    "app/api/maintenance/ai-control-plane/bindings/route.maintenance.ts",
    "app/api/maintenance/ai-control-plane/probes/route.maintenance.ts",
    "app/api/maintenance/ai-control-plane/budgets/route.maintenance.ts",
    "app/api/maintenance/ai-control-plane/secret-commands/route.maintenance.ts",
    "app/api/admin/llm-profiles/route.maintenance.ts",
    "app/api/admin/llm-profiles/[id]/route.maintenance.ts",
    "app/api/admin/llm-profiles/[id]/revisions/route.maintenance.ts",
    "app/api/admin/agent-role-bindings/route.maintenance.ts",
    "app/api/admin/agent-role-bindings/test/route.maintenance.ts",
    "app/api/admin/runtime-explanation-bindings/route.maintenance.ts",
    "app/api/admin/runtime-explanation-bindings/test/route.maintenance.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /automaticAuditReason\(/, path);
    assert.doesNotMatch(source, /maintenanceReason\(|body\.reason/, path);
  }
});
