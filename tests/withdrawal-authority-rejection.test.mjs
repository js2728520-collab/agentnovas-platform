import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// INV-11：平台永不持有提现权限。
//
// 由来：检测能力一直有（exchange-adapters 会解析 canWithdraw），但 check 动作
// 只把它记进审计和响应，然后无条件把账户置为 active——**检测出来了却不拒绝**。
//
// 而 credential-access.ts 里注释为「读取侧的第二道」的那句守卫读的是数据库列
// withdrawal_authorized，该列被 migration 0045 的 CHECK 强制为 0，
// 所以那道防线永远不会触发。两道防线实际都不存在。

const checkRoute = await readFile(
  new URL("../app/api/exchange-accounts/[id]/route.client.ts", import.meta.url), "utf8");

test("检测到提现权限必须拒绝，而不只是记录", () => {
  assert.match(checkRoute, /result\.canWithdraw === true/, "必须对交易所返回的真实权限做判断");
  assert.match(checkRoute, /WITHDRAWAL_AUTHORITY_FORBIDDEN/);
});

test("拒绝时账户不得停留在 active", () => {
  const branch = checkRoute.slice(
    checkRoute.indexOf("result.canWithdraw === true"),
    checkRoute.indexOf('status = "active";'),
  );
  assert.match(branch, /status: "disconnected"/, "带提现权限的账户必须被断开");
  assert.match(branch, /canTrade: false/);
  assert.match(branch, /withdrawal_authority_rejected/, "拒绝动作必须留审计");
});

test("拒绝分支排在置 active 之前", () => {
  // 顺序写反等于没有这道检查。
  assert.ok(
    checkRoute.indexOf("result.canWithdraw === true") < checkRoute.indexOf('status = "active";'),
    "提现权限判断必须发生在置 active 之前",
  );
});

test("数据库那道 CHECK 仍在——它挡的是另一件事", async () => {
  // 0045 保证平台不会**存储**提现凭证；本测试保证平台不会**接受**带提现权限的密钥。
  // 两者是不同的防线，不能互相替代。
  const migration = await readFile(
    new URL("../postgres/migrations/0045_no_withdrawal_authority.sql", import.meta.url), "utf8");
  assert.match(migration, /withdrawal_authorized = 0 AND withdrawal_credential_ref IS NULL/);
});
