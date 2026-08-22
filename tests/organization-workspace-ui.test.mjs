import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Operations organization UI uses one-time password invitations and approval-bound reporting changes", async () => {
  const ui = await readFile(new URL("../apps/operations/ui/organization-workspace.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/organization/members/route.operations.ts", import.meta.url), "utf8");
  const provision = await readFile(new URL("../lib/internal-member-provisioning.ts", import.meta.url), "utf8");
  assert.match(ui, /不会生成或回显临时密码/);
  assert.match(ui, /批准前当前汇报关系不变/);
  assert.match(route, /readResearchJson\(request, 4_096\)/);
  assert.match(route, /ORGANIZATION_REASON_INVALID/);
  assert.match(provision, /email_set_password/);
});
