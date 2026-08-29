import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("T8.2c registers exact Maintenance workflow permissions and role breakpoints", async () => {
  const [rbac, migration, app] = await Promise.all([
    read("lib/rbac.ts"), read("postgres/migrations/0084_restricted_cicd_maintenance_control.sql"),
    read("apps/maintenance/ui/maintenance-app.tsx"),
  ]);
  const permissions = [
    "view", "stage", "production.request", "production.approve", "activation.request",
    "activation.approve", "production.enable", "stop", "stop.release",
  ].map((suffix) => `maint.releases.workflow.${suffix}`);
  for (const permission of permissions) {
    assert.match(rbac, new RegExp(permission.replaceAll(".", "\\.")));
    assert.match(migration, new RegExp(permission.replaceAll(".", "\\.")));
  }
  const technical = rbac.slice(rbac.indexOf('case "tech_staff"'), rbac.indexOf('case "hq_support"'));
  for (const makerPermission of ["workflow.view", "workflow.stage", "workflow.production.request", "workflow.activation.request"])
    assert.match(technical, new RegExp(makerPermission.replaceAll(".", "\\.")));
  for (const governancePermission of ["workflow.production.approve", "workflow.activation.approve", "workflow.production.enable", "workflow.stop", "workflow.stop.release"])
    assert.doesNotMatch(technical, new RegExp(governancePermission.replaceAll(".", "\\.")));
  assert.match(app, /canViewEvidence/);
  assert.doesNotMatch(app, /workflowPermissions|RestrictedCicdWorkspace/);
});

test("T8.2c routes are actor-derived, auditable, idempotent where created, and never expose terminal gateways", async () => {
  const [service, grants, inventory, migration, access] = await Promise.all([
    read("lib/restricted-cicd-maintenance-service.ts"),
    read("deploy/postgres/least-privilege-roles.sql"),
    read("lib/api-route-inventory.ts"),
    read("postgres/migrations/0084_restricted_cicd_maintenance_control.sql"),
    read("lib/access-control.ts"),
  ]);
  for (const route of [
    "/api/maintenance/release-workflow", "/api/maintenance/release-workflow/activations",
    "/api/maintenance/release-workflow/commands/staging", "/api/maintenance/release-workflow/commands/production",
    "/api/maintenance/release-workflow/stops", "/api/maintenance/release-workflow/stops/release",
  ]) assert.match(inventory, new RegExp(route.replaceAll("/", "\\/")));
  assert.doesNotMatch(service, /release_workflow_append_maintenance_audit/);
  assert.match(migration, /INSERT INTO audit_logs/);
  assert.match(migration, /PERFORM release_workflow_append_maintenance_audit/);
  assert.match(service, /idempotencyKey/);
  assert.match(service, /function factId/);
  assert.match(service, /\["environment", "action", "reason"\]/);
  assert.doesNotMatch(service, /body\.imageDigests|body\.migrationSetSha256|body\.hasIrreversibleMigrations/);
  assert.match(access, /alwaysMfaProtectedReleaseMutation/);
  assert.match(service, /sessionSecret/);
  assert.doesNotMatch(service, /sessionTokenHash/);
  assert.match(migration, /release_workflow_require_maintenance_actor/);
  assert.match(migration, /session\.token_hash=encode\(sha256\(convert_to\(p_session_secret,'UTF8'\)\),'hex'\)/);
  assert.doesNotMatch(migration, /p_session_token_hash/);
  assert.match(migration, /session\.mfa_verified_at>CURRENT_TIMESTAMP-interval '15 minutes'/);
  assert.match(migration, /release_workflow_artifact_manifests/);
  assert.match(migration, /release_workflow_control_bundles/);
  assert.match(migration, /release_workflow_actor_authorities/);
  assert.match(migration, /authority\.actor_kind='human'/);
  assert.match(migration, /release_workflow_restore_capabilities/);
  assert.match(migration, /rollbackRecoveryCapability/);
  assert.match(migration, /restore_drill_result='passed'/);
  assert.match(grants, /release_workflow_execute_human_action/);
  assert.match(grants, /release_workflow_issue_human_action_authority/);
  assert.match(grants, /agentnovas_release_identity_verifier/);
  const maintenanceGrant = grants.match(/GRANT EXECUTE ON FUNCTION public\.release_workflow_read_maintenance_control\(integer\)[\s\S]*?TO agentnovas_maint_web;/)?.[0] ?? "";
  const releaseControlGrant = grants.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO agentnovas_release_control;/)?.[0] ?? "";
  assert.match(maintenanceGrant, /release_workflow_read_maintenance_control/);
  assert.doesNotMatch(maintenanceGrant, /request_command|review_command|request_activation|review_activation|request_stop/);
  assert.match(releaseControlGrant, /release_workflow_execute_human_action/);
  assert.doesNotMatch(releaseControlGrant, /release_workflow_request_command_v2|release_workflow_request_stop_v2|release_workflow_record_human_action_assertion/);
  assert.doesNotMatch(releaseControlGrant, /release_workflow_append_maintenance_audit/);
  for (const forbidden of ["release_workflow_record_activation(", "release_workflow_record_provider_binding(", "release_workflow_record_first_production_enablement(", "release_workflow_clear_stop("])
    assert.doesNotMatch(releaseControlGrant, new RegExp(forbidden.replace("(", "\\(")));
  for (const revoked of ["release_workflow_request_command(", "release_workflow_review_command("])
    assert.match(await read("postgres/migrations/0084_restricted_cicd_maintenance_control.sql"), new RegExp(`REVOKE EXECUTE ON FUNCTION ${revoked.replace("(", "\\(")}`));
  const serializedInventory = inventory.match(/API_ROUTE_INVENTORY = (\[[\s\S]*\]) as const/)?.[1];
  assert.ok(serializedInventory);
  const workflowMutations = JSON.parse(serializedInventory)
    .filter((entry) => entry.route.startsWith("/api/maintenance/release-workflow") && entry.method === "POST");
  assert.equal(workflowMutations.length, 10);
  assert.ok(workflowMutations.every((entry) => entry.idempotency === true));
});

test("T8.2c UI communicates default-off behavior and uses accessible inline controls", async () => {
  const ui = await read("apps/maintenance/ui/restricted-cicd-workspace.tsx");
  assert.match(ui, /DEFAULT-OFF RELEASE ORCHESTRATOR/);
  assert.match(ui, /Worker、Ingress、目标网关和专用 workflow 未通过 G7 前仍保持关闭/);
  assert.match(ui, /aria-live="polite"/);
  assert.match(ui, /aria-label="受限发布环境状态"/);
  assert.match(ui, /InlineAuditReasonField/);
  assert.match(ui, /structuredClone\(input\.body\)/);
  assert.match(ui, /pending\?\.body \?\? input\.body/);
  assert.match(ui, /requestId: crypto\.randomUUID\(\)/);
  assert.match(ui, /"x-request-id": pending\.requestId/);
  assert.match(ui, /isTerminalActionRejection\(response\.status\)[\s\S]*idempotency\.current\.delete/);
  assert.match(ui, /!new Set\(\[408, 425, 428, 429\]\)\.has\(status\)/);
  assert.doesNotMatch(ui, /G7 与运行绑定 JSON|制品与迁移 JSON|defaultCommandMaterial|defaultActivationBindings/);
  assert.match(ui, /服务端制品事实/);
  assert.doesNotMatch(ui, /confirm\(|window\.confirm|<dialog/i);
  assert.match(ui, /提交人|requestedByUserId !== currentUserId/);
});
