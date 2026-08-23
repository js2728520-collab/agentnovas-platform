import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("versioned configuration routes are Maintenance-only, idempotent and explicitly permissioned", async () => {
  const [collection, testRoute, approval, schedule, activation, rbac, migration, grants, rolePolicy, service, openapi] = await Promise.all([
    read("app/api/maintenance/configuration-versions/route.maintenance.ts"),
    read("app/api/maintenance/configuration-versions/[id]/tests/route.maintenance.ts"),
    read("app/api/maintenance/configuration-versions/[id]/approval/route.maintenance.ts"),
    read("app/api/maintenance/configuration-versions/[id]/schedule/route.maintenance.ts"),
    read("app/api/maintenance/configuration-versions/[id]/activation/route.maintenance.ts"),
    read("lib/rbac.ts"),
    read("postgres/migrations/0069_versioned_configuration_framework.sql"),
    read("deploy/postgres/least-privilege-roles.sql"),
    read("scripts/release/postgres-role-policy.mjs"),
    read("lib/versioned-configuration-service.ts"),
    read("docs/api/openapi-controlled-beta.yaml"),
  ]);
  const allRoutes = [collection, testRoute, approval, schedule, activation];
  for (const source of allRoutes) assert.match(source, /idempotencyKey\(request\)/);
  assert.match(collection, /maint\.configuration_versions\.view/);
  assert.match(collection, /maint\.configuration_versions\.manage/);
  assert.match(testRoute, /maint\.configuration_versions\.manage/);
  assert.match(approval, /maint\.configuration_versions\.approve/);
  assert.match(schedule, /maint\.configuration_versions\.approve/);
  assert.match(activation, /maint\.configuration_versions\.activate/);
  for (const permission of ["view", "manage", "approve", "activate"]) {
    const pattern = new RegExp(`maint\\.configuration_versions\\.${permission}`);
    assert.match(rbac, pattern);
    assert.match(migration, pattern);
  }
  assert.match(migration, /configuration records are immutable/);
  assert.match(grants, /configuration_versions[\s\S]+agentnovas_maint_web/);
  assert.doesNotMatch(grants, /configuration_versions[\s\S]{0,300}agentnovas_(?:client|ops)_web/);
  assert.match(rolePolicy, /CONFIGURATION_CONTROL_TABLES/);
  assert.match(service, /normalizeRegisteredConfigurationFamilyTestRequest/);
  assert.match(service, /runRegisteredConfigurationFamilyTest/);
  assert.match(openapi, /注册配置族服务端测试请求/);
  assert.match(openapi, /oneOf:/);
});
