import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildStaffInvitationLink, staffInvitationAudience } from "../lib/invitation-links.ts";
import { childRole } from "../lib/permissions.ts";
import { legacyRoleAssignments } from "../lib/rbac.ts";

// 员工邀请链接的三条不变量：指向正确的端、角色不可自选、注册不等于生效。

test("链接指向目标角色该进的那个端", () => {
  // 发错端会让人登进一个自己没有任何权限的应用——页面打得开，点哪里都是
  // AccessDenied，而原因完全看不出来。
  assert.equal(staffInvitationAudience("tech_staff"), "maintenance");
  for (const role of ["employee", "supervisor", "manager", "branch_admin"]) {
    assert.equal(staffInvitationAudience(role), "operations");
  }
  assert.equal(
    buildStaffInvitationLink("https://ops.example.com/", "ABC", "maintenance"),
    "https://ops.example.com/login?staff-invite=ABC&app=maintenance",
  );
});

test("技术人员不在 childRole 链上", () => {
  // 那条链表达业务汇报关系。技术人员既不管客户也不产生业绩，硬塞进去会让归因和
  // 团队目标多出一类永远为空的节点。
  assert.ok(!Object.values(childRole).includes("tech_staff"));
});

test("技术人员的角色分配落在运维端，且不含治理权限", () => {
  const assignments = legacyRoleAssignments("tech_staff");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].appId, "maintenance");
  const keys = new Set(assignments[0].permissions.map((p) => p.permissionKey));

  // 该有的
  for (const key of ["maint.llm_profiles.manage", "maint.system_health.view", "maint.releases.manage"]) {
    assert.ok(keys.has(key), `技术人员应该有 ${key}`);
  }
  // 刻意不给的：每一条都有具体理由，见 rbac.ts 的注释
  for (const key of [
    "maint.roles.manage",            // 能给自己加权限的技术账号等于没有权限体系
    "maint.roles.approve_sensitive",
    "maint.releases.approve",        // 登记的人不能自己复核
    "maint.emergency_pause.execute", // 熔断是业务决定
    "maint.demo_exchanges.kill",
    "maint.payment_integrations.manage",
    "maint.commercial_disclosures.approve",
  ]) {
    assert.ok(!keys.has(key), `技术人员不应该有 ${key}`);
  }
});

test("链接注册产出待批准状态，不产出可用账号", async () => {
  // 链接只省掉「上级手工录入对方资料」这一步，不省审批。
  const route = await readFile(new URL("../app/api/organization/staff-register/route.internal.ts", import.meta.url), "utf8");
  assert.match(route, /status: "pending_approval"/);
  assert.equal(/status:\s*"active"/.test(route), false, "注册路径不得直接激活账号");
});

test("不建那张没人能处理的审批单", async () => {
  // 通用审批接口只处理 reporting_line_change，其余类型一律 503。
  // 建了只会得到一张永远卡住的单，而运营会以为有人在处理。
  const route = await readFile(new URL("../app/api/organization/staff-register/route.internal.ts", import.meta.url), "utf8");
  assert.equal(/db\.insert\(approvalRequests\)/.test(route), false);
  assert.match(route, /invitedViaInvitationId: invitation\.id/, "改为记录来源，激活时据此排除邀请人");
});

test("邀请人不能批准通过自己链接进来的人", async () => {
  // canManuallyActivateMember 只挡「激活自己」。生成链接的人同时批准通过链接进来的
  // 人，等于一个人走完全程，双人复核名存实亡。
  const route = await readFile(
    new URL("../app/api/organization/members/[id]/activate/route.operations.ts", import.meta.url), "utf8");
  assert.match(route, /INVITER_CANNOT_APPROVE/);
  assert.match(route, /invitation\?\.owner_employee_id === actor\.id/);
});

test("激活时按角色选对应的端校验角色分配", async () => {
  // 此前写死 operations，技术人员的分配在运维端，会被判成「尚未完成显式角色分配」
  // ——一个正确但完全看不出原因的失败。
  const route = await readFile(
    new URL("../app/api/organization/members/[id]/activate/route.operations.ts", import.meta.url), "utf8");
  assert.match(route, /member\.role === "tech_staff" \? "maintenance" : "operations"/);
  assert.equal(/application_id = 'operations'/.test(route), false, "不得写死端");
});

test("角色来自链接，不接受注册者自选", async () => {
  const route = await readFile(new URL("../app/api/organization/staff-register/route.internal.ts", import.meta.url), "utf8");
  assert.match(route, /role: invitation\.targetRole/);
  // body.role 出现即意味着注册者能影响自己的角色。
  assert.equal(/body\.role/.test(route), false, "注册者不得指定角色");
});

test("链接失效与不存在返回同一个错误", async () => {
  // 区分开等于给暴力猜码的人一个信号：「这个码存在，只是过期了」。
  const route = await readFile(new URL("../app/api/organization/staff-register/route.internal.ts", import.meta.url), "utf8");
  const matches = route.match(/STAFF_INVITE_INVALID/g) ?? [];
  assert.ok(matches.length >= 1);
  assert.match(route, /不区分「链接不存在」与「链接已失效」/);
});

test("只有 hq_admin 能建技术人员", async () => {
  const route = await readFile(new URL("../app/api/organization/members/route.operations.ts", import.meta.url), "utf8");
  assert.match(route, /actor\.role !== "hq_admin"/);
  assert.match(route, /内部角色由汇报关系推导，不可指定/, "其余角色不得自选");
});
