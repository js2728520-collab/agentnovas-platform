import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Maintenance exposes a permission-scoped configuration release workspace", async () => {
  const [routes, navigation, application] = await Promise.all([
    read("app/riverton-route-contract.ts"),
    read("apps/maintenance/ui/navigation.ts"),
    read("apps/maintenance/ui/maintenance-app.tsx"),
  ]);
  assert.match(routes, /"configurations"/);
  assert.match(navigation, /href: "\/configurations"/);
  assert.match(navigation, /maint\.configuration_versions\.view/);
  assert.match(application, /ConfigurationVersionsWorkspace/);
  assert.match(application, /maint\.configuration_versions\.manage/);
  assert.match(application, /maint\.configuration_versions\.approve/);
  assert.match(application, /maint\.configuration_versions\.activate/);
});

test("ordinary draft and test commands stay inline while release-risk commands require confirmation", async () => {
  const [workspace, create, detail] = await Promise.all([
    read("apps/maintenance/ui/configuration-versions-workspace.tsx"),
    read("apps/maintenance/ui/configuration-version-create-panel.tsx"),
    read("apps/maintenance/ui/configuration-version-detail-panel.tsx"),
  ]);
  const ordinaryActions = `${create}\n${detail}`;
  assert.match(ordinaryActions, /InlineAuditReasonField/);
  assert.match(ordinaryActions, /登记测试证据/);
  assert.match(workspace, /尚未接管具体运行时/);
  assert.match(workspace, /ConfirmActionDialog/);
  assert.match(workspace, /kind: "approval"/);
  assert.match(workspace, /kind: "schedule"/);
  assert.match(workspace, /kind: "activation"/);
  assert.match(workspace, /nextCursor/);
  assert.match(workspace, /加载更早版本/);
  assert.doesNotMatch(workspace, /kind: "create"|kind: "test"/);
});

test("local schedule input is serialized with an explicit UTC offset", async () => {
  const helper = await import("../apps/maintenance/ui/configuration-version-ui.ts");
  assert.equal(helper.localDateTimeWithOffset("2026-08-24T09:30", -480), "2026-08-24T09:30:00+08:00");
  assert.equal(helper.localDateTimeWithOffset("2026-01-02T03:04", 300), "2026-01-02T03:04:00-05:00");
  assert.equal(helper.localDateTimeWithOffset("", -480), "");
  assert.equal(helper.offsetForLocalDateTime(""), 0);
});
