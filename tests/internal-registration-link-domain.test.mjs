import assert from "node:assert/strict";
import test from "node:test";

import {
  canIssueInternalRegistrationLink,
  invitableInternalRoles,
  resolveInternalRegistrationLinkScope,
} from "../packages/domain/src/organization-provisioning.ts";

test("五级 Operations 角色只能向下生成权限注册链接", () => {
  assert.deepEqual(invitableInternalRoles("hq_admin"), [
    "branch_admin",
    "manager",
    "supervisor",
    "employee",
  ]);
  assert.deepEqual(invitableInternalRoles("branch_admin"), ["manager", "supervisor", "employee"]);
  assert.deepEqual(invitableInternalRoles("manager"), ["supervisor", "employee"]);
  assert.deepEqual(invitableInternalRoles("supervisor"), ["employee"]);
  assert.deepEqual(invitableInternalRoles("employee"), []);
});

test("同级、上级、客户和技术角色都不能通过 Operations 权限链接授予", () => {
  assert.equal(canIssueInternalRegistrationLink("manager", "manager"), false);
  assert.equal(canIssueInternalRegistrationLink("manager", "branch_admin"), false);
  assert.equal(canIssueInternalRegistrationLink("hq_admin", "hq_admin"), false);
  assert.equal(canIssueInternalRegistrationLink("hq_admin", "customer"), false);
  assert.equal(canIssueInternalRegistrationLink("hq_admin", "tech_staff"), false);
  assert.equal(canIssueInternalRegistrationLink("customer", "employee"), false);
});

test("总公司总经理生成分公司总经理链接时由注册事务创建分公司", () => {
  assert.deepEqual(resolveInternalRegistrationLinkScope({
    issuerRole: "hq_admin",
    targetRole: "branch_admin",
    issuerOrganizationId: "hq-org",
    targetOrganizationId: null,
  }), {
    ok: true,
    organizationMode: "CREATE_BRANCH",
    organizationId: null,
  });
});

test("总公司跨分公司生成经理及以下链接时必须锁定目标分公司", () => {
  assert.deepEqual(resolveInternalRegistrationLinkScope({
    issuerRole: "hq_admin",
    targetRole: "manager",
    issuerOrganizationId: "hq-org",
    targetOrganizationId: null,
  }), { ok: false, code: "TARGET_ORGANIZATION_REQUIRED" });

  assert.deepEqual(resolveInternalRegistrationLinkScope({
    issuerRole: "hq_admin",
    targetRole: "manager",
    issuerOrganizationId: "hq-org",
    targetOrganizationId: "branch-2",
  }), {
    ok: true,
    organizationMode: "EXISTING_ORGANIZATION",
    organizationId: "branch-2",
  });
});

test("分公司内生成链接只能继承自己的组织范围", () => {
  assert.deepEqual(resolveInternalRegistrationLinkScope({
    issuerRole: "manager",
    targetRole: "employee",
    issuerOrganizationId: "branch-1",
    targetOrganizationId: null,
  }), {
    ok: true,
    organizationMode: "EXISTING_ORGANIZATION",
    organizationId: "branch-1",
  });

  assert.deepEqual(resolveInternalRegistrationLinkScope({
    issuerRole: "manager",
    targetRole: "employee",
    issuerOrganizationId: "branch-1",
    targetOrganizationId: "branch-2",
  }), { ok: false, code: "TARGET_ORGANIZATION_OUT_OF_SCOPE" });
});

test("越级目标在解析范围前即失败关闭", () => {
  assert.deepEqual(resolveInternalRegistrationLinkScope({
    issuerRole: "supervisor",
    targetRole: "manager",
    issuerOrganizationId: "branch-1",
    targetOrganizationId: null,
  }), { ok: false, code: "ROLE_ESCALATION_FORBIDDEN" });
});
