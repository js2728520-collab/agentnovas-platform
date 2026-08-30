import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("invitation links regenerate directly with an inline invalidation warning", async () => {
  const source = await read("apps/operations/ui/invitations-workspace.tsx");

  assert.doesNotMatch(source, /ConfirmActionDialog|setConfirming|confirming/);
  assert.match(source, /onClick=\{generate\}/);
  assert.match(source, /当前链接立即失效/);
});

test("organization configuration submits direct actions with server-owned audit", async () => {
  const source = await read("apps/operations/ui/organization-workspace.tsx");

  assert.doesNotMatch(source, /ConfirmActionDialog|PendingAction|setPending/);
  assert.doesNotMatch(source, /auditReason|审计原因|reasonReady/);
  assert.doesNotMatch(source, /body: JSON\.stringify\([^]*reason/);
  assert.match(source, /disabled=\{busy/);
});

test("account lifecycle actions submit directly with server-owned audit", async () => {
  const source = await read("apps/operations/ui/accounts-workspace.tsx");

  assert.doesNotMatch(source, /ConfirmActionDialog|setPending|pending/);
  assert.doesNotMatch(source, /auditReason|审计原因|reasonReady/);
  assert.match(source, /changeStatus\(account\)/);
  assert.match(source, /停用会立即撤销/);
  assert.match(source, /服务端自动留痕/);
});

test("relationship reinvite and strategy rollback have no native confirmation", async () => {
  const [tree, backtest] = await Promise.all([
    read("app/organization-relationship-tree.tsx"),
    read("apps/client/ui/strategy-backtest-detail.tsx"),
  ]);

  assert.doesNotMatch(tree, /window\.confirm|\bconfirm\(/);
  assert.match(tree, /activatingId === selected\.id \? "正在加入邮件队列…"/);
  assert.match(tree, /aria-live="polite"/);

  assert.doesNotMatch(backtest, /window\.confirm|\bconfirm\(/);
  assert.match(backtest, /不会覆盖任何历史记录/);
  assert.match(backtest, /disabled=\{busy\}/);
  assert.match(backtest, /正在将 V\$\{sourceVersion\} 恢复为新的 V\$\{nextVersion\}/);
});
