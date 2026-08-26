import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ORGANIZATION_NAME_MAX,
  checkOrganizationName,
  createsOrganization,
} from "../packages/domain/src/organization-provisioning.ts";

// 建分公司是整棵组织树上唯一的建组织入口，而它藏在「邀请下一级成员」里。
// 名称此前是可选的，留空就用邮箱前缀——组织树、业绩归因、数据可见范围都挂在
// 那个名字上。

test("只有分支管理员会顺带开组织", () => {
  assert.equal(createsOrganization("branch_admin"), true);
  for (const role of ["manager", "supervisor", "employee", "tech_staff", "hq_admin", "customer"]) {
    assert.equal(createsOrganization(role), false, `${role} 不该创建组织`);
  }
});

test("建分公司时名称必填，空白不算填", () => {
  for (const raw of [undefined, null, "", "   ", "\t\n", 42, {}, "上"]) {
    const result = checkOrganizationName("branch_admin", raw);
    assert.equal(result.ok, false, `${JSON.stringify(raw)} 应被拒绝`);
    assert.equal(result.code, "ORGANIZATION_NAME_REQUIRED");
  }
});

test("名称按去空白后的长度判定，并原样返回去空白结果", () => {
  const result = checkOrganizationName("branch_admin", "  华东分公司  ");
  assert.equal(result.ok, true);
  assert.equal(result.name, "华东分公司", "存进数据库的不该带首尾空白");

  assert.equal(checkOrganizationName("branch_admin", "x".repeat(ORGANIZATION_NAME_MAX)).ok, true);
  assert.equal(checkOrganizationName("branch_admin", "x".repeat(ORGANIZATION_NAME_MAX + 1)).ok, false,
    "超长要挡在这里，而不是等数据库截断");
});

test("不建组织的角色不要求名称，也不回传名称", () => {
  // 这类角色即使传了名称也不会用到。回 null 是为了让调用方拿不到一个会被丢弃的值。
  for (const raw of [undefined, "随手填的"]) {
    const result = checkOrganizationName("employee", raw);
    assert.equal(result.ok, true);
    assert.equal(result.name, null);
  }
});

test("邮箱前缀 fallback 不再能被触发", async () => {
  // fallback 本身留着——直接调 provisioning 的其它路径仍可能不传名称。
  // 但 API 这一层必须先过校验，否则守卫等于没有。
  const route = await readFile(new URL("../app/api/organization/members/route.operations.ts", import.meta.url), "utf8");
  assert.match(route, /checkOrganizationName\(role, body\.name\)/);
  // 错误码只在域层定义一处，路由把它原样透出——两边各写一遍迟早会不一致。
  assert.match(route, /code: nameCheck\.code/);
  assert.match(route, /status: 422/);
  // 传下去的必须是校验过的那个值，不是原始 body——否则首尾空白会进数据库。
  assert.match(route, /organizationName: nameCheck\.name \?\? undefined/);
  assert.doesNotMatch(route, /organizationName: typeof body\.name/);

  const guardIndex = route.indexOf("checkOrganizationName(role, body.name)");
  const provisionIndex = route.indexOf("await provisionInternalMember(");
  assert.ok(guardIndex > 0 && provisionIndex > guardIndex, "校验必须发生在建人建组织之前");
});

test("界面据同一条判定决定输入框与按钮，不各写一遍", async () => {
  const ui = await readFile(new URL("../apps/operations/ui/organization-workspace.tsx", import.meta.url), "utf8");
  // 界面不该自己猜「谁会建组织」——后端 childRole 是唯一权威，经 nextRole 下发。
  assert.match(ui, /tree\.data\?\.nextRole === "branch_admin"/);
  assert.match(ui, /分公司名称（必填/);
  assert.match(ui, /!branchNameReady/, "名称没填时提交按钮必须是灰的");
  assert.doesNotMatch(ui, /仅创建分支管理员时使用/, "旧的可选文案应已移除");
});
