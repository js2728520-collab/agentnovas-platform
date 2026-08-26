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

test("the complete configuration release flow stays inline without modal confirmations", async () => {
  const [workspace, create, detail] = await Promise.all([
    read("apps/maintenance/ui/configuration-versions-workspace.tsx"),
    read("apps/maintenance/ui/configuration-version-create-panel.tsx"),
    read("apps/maintenance/ui/configuration-version-detail-panel.tsx"),
  ]);
  const ordinaryActions = `${create}\n${detail}`;
  assert.match(ordinaryActions, /InlineAuditReasonField/);
  assert.match(ordinaryActions, /登记测试证据/);
  assert.match(workspace, /尚未接管具体运行时/);
  assert.doesNotMatch(workspace, /ConfirmActionDialog/);
  assert.doesNotMatch(workspace, /PendingAction|setPending/);
  assert.match(detail, /审批原因/);
  assert.match(detail, /调度原因/);
  assert.match(detail, /激活原因/);
  assert.match(detail, /回滚原因/);
  assert.doesNotMatch(detail, /确认立即激活|核对并安排生效/);
  assert.match(workspace, /nextCursor/);
  assert.match(workspace, /加载更早版本/);
});

test("registered strategy research flag uses a constrained draft form and server-run test", async () => {
  const [workspace, create, detail] = await Promise.all([
    read("apps/maintenance/ui/configuration-versions-workspace.tsx"),
    read("apps/maintenance/ui/configuration-version-create-panel.tsx"),
    read("apps/maintenance/ui/configuration-version-detail-panel.tsx"),
  ]);
  assert.match(create, /client\.strategy_research/);
  assert.match(create, /模块状态/);
  assert.match(create, /发布范围/);
  assert.match(create, /指定用户 ID/);
  assert.match(create, /指定组织 ID/);
  assert.match(create, /指定应用版本/);
  assert.match(create, /灰度百分比/);
  assert.match(create, /独立开始时间/);
  assert.match(create, /独立结束时间/);
  // PS3 把 payload 构造抽成 structuredPayload()，Prompt/Skill 与开关共用一条提交路径。
  // 契约没变——注册族的 schemaVersion 仍由发布范围决定而不是运维填写，定向规则仍走
  // targetedPayload()——只是不再是两个并列的三元分支，所以断言跟着改写法。
  assert.match(create, /registeredFeatureFlag && targetedFeatureFlag \? 2/);
  assert.match(create, /if \(registeredFeatureFlag\) return targetedFeatureFlag \? targetedPayload\(\) : \{ enabled: featureEnabled \}/);
  assert.match(create, /readOnly=\{registeredFeatureFlag\}/);
  assert.match(detail, /\[1, 2\]\.includes\(version\.schemaVersion\)/);
  assert.match(workspace, /\[1, 2\]\.includes\(version\.schemaVersion\)/);
  assert.match(detail, /运行确定性测试/);
  assert.match(detail, /结果与证据 SHA-256 均由服务端/);
  assert.match(workspace, /runRegisteredTest/);
  assert.match(workspace, /\{ reason \}/);
  assert.match(workspace, /策略研究入口将在下一次请求/);
  assert.match(workspace, /环境 Gate 与 current 功能开关/);
  assert.match(workspace, /全局或定向规则/);
});

test("local schedule input is serialized with an explicit UTC offset", async () => {
  const helper = await import("../apps/maintenance/ui/configuration-version-ui.ts");
  assert.equal(helper.localDateTimeWithOffset("2026-08-24T09:30", -480), "2026-08-24T09:30:00+08:00");
  assert.equal(helper.localDateTimeWithOffset("2026-01-02T03:04", 300), "2026-01-02T03:04:00-05:00");
  assert.equal(helper.localDateTimeWithOffset("", -480), "");
  assert.equal(helper.offsetForLocalDateTime(""), 0);
});

test("target lists are deterministic across comma, newline, whitespace and duplicate input", async () => {
  const helper = await import("../apps/maintenance/ui/configuration-version-ui.ts");
  assert.deepEqual(
    helper.splitTargetValues(" user-b, user-a\nuser-a\n\nbranch:1 "),
    ["branch:1", "user-a", "user-b"],
  );
  assert.deepEqual(helper.splitTargetValues(""), []);
});
