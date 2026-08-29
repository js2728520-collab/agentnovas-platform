import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("release management is a Maintenance-only stable route with explicit permissions", async () => {
  const [rbac, routeContract, app, workspace, migration, grants] = await Promise.all([
    read("lib/rbac.ts"),
    read("app/riverton-route-contract.ts"),
    Promise.all([read("apps/maintenance/ui/maintenance-app.tsx"), read("apps/maintenance/ui/maintenance-information-architecture.ts")]).then((parts) => parts.join("\n")),
    read("apps/maintenance/ui/release-management-workspace.tsx"),
    read("postgres/migrations/0041_release_version_management.sql"),
    read("deploy/postgres/least-privilege-roles.sql"),
  ]);
  for (const permission of ["maint.releases.view", "maint.releases.manage", "maint.releases.approve"]) {
    assert.match(rbac, new RegExp(permission.replaceAll(".", "\\.")));
    assert.match(migration, new RegExp(permission.replaceAll(".", "\\.")));
  }
  assert.match(routeContract, /MAINTENANCE_ROUTES[^\n]+"releases"/);
  assert.match(app, /href:\s*"\/releases"/);
  assert.match(workspace, /平台控制面只登记证据/);
  assert.match(workspace, /提交人不能复核/);
  assert.match(migration, /sequence_no bigint GENERATED ALWAYS AS IDENTITY/i);
  assert.match(grants, /release_versions[\s\S]+agentnovas_maint_web/);
  assert.doesNotMatch(grants, /release_versions[\s\S]{0,300}agentnovas_(?:client|ops)_web/);
});

test("release API routes require idempotent explicit permissions", async () => {
  const [collection, verification, deployment] = await Promise.all([
    read("app/api/maintenance/releases/route.maintenance.ts"),
    read("app/api/maintenance/releases/[id]/verification/route.maintenance.ts"),
    read("app/api/maintenance/releases/[id]/deployments/route.maintenance.ts"),
  ]);
  assert.match(collection, /maint\.releases\.view/);
  assert.match(collection, /maint\.releases\.manage/);
  assert.match(collection, /idempotencyKey\(request\)/);
  for (const source of [verification, deployment]) {
    assert.match(source, /maint\.releases\.approve/);
    assert.match(source, /idempotencyKey\(request\)/);
  }
});
