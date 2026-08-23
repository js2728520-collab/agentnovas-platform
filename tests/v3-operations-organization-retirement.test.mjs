import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isRivertonPagePath } from "../app/riverton-route-contract.ts";

test("Operations 不再暴露组织架构页面但保留权限注册链接入口", async () => {
  const navigation = await readFile(new URL("../apps/operations/ui/navigation.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../apps/operations/ui/operations-app.tsx", import.meta.url), "utf8");
  assert.equal(isRivertonPagePath("operations", "/organization"), false);
  assert.equal(isRivertonPagePath("operations", "/invitations"), true);
  assert.equal(isRivertonPagePath("operations", "/accounts"), true);
  assert.doesNotMatch(navigation, /href:\s*["']\/organization["']/);
  assert.doesNotMatch(navigation, /组织架构/);
  assert.doesNotMatch(app, /OrganizationWorkspace/);
  assert.doesNotMatch(app, /route === ["']organization["']/);
  assert.match(app, /AccountsWorkspace/);
  const accounts = await readFile(new URL("../apps/operations/ui/accounts-workspace.tsx", import.meta.url), "utf8");
  assert.match(accounts, /view=accounts/);
  assert.doesNotMatch(accounts, /OrganizationRelationshipTree|view=tree|汇报关系/);
});

test("停用内部账号同时撤销会话、令牌和其签发的权限链接", async () => {
  const route = await readFile(
    new URL("../app/api/organization/members/[id]/status/route.operations.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /UPDATE sessions SET revoked_at/);
  assert.match(route, /UPDATE auth_tokens SET used_at/);
  assert.match(route, /UPDATE internal_registration_links[\s\S]*issuer_user_id=\$1[\s\S]*status='active'/);
  assert.match(route, /canIssueInternalRegistrationLink\(actor\.role, member\.role\)/);
  assert.match(route, /WITH RECURSIVE reporting_chain/);
});
