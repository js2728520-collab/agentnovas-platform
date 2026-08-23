
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
// —— 生产上真实踩到的两个 bug ——

test("邀请链接指向客户端站点，不是生成它的运营端", async () => {
  // 这个接口只在运营端提供，请求 origin 是 zht.agentnovas.com。回退到请求 origin
  // 会生成一条指向运营控制台的链接——客户点开落在一个他登录不了的后台，
  // 而发链接的人完全看不出问题：链接长得很正常。
  const source = await readFile(new URL("../app/api/invitations/link/route.operations.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CLIENT_PUBLIC_BASE_URL[^\n]*\|\|\s*new URL\(request\.url\)\.origin/,
    "不得回退到请求自己的 origin");
  assert.match(source, /APP_DEFINITIONS/, "客户端域名应取自全仓库同一份 audience 映射");
  assert.match(source, /app\.id === "client"/);
});

test("可复用链接的计数走 SECURITY DEFINER 函数，不直接写 invitations", async () => {
  // invitations 是客户端角色被 REVOKE ALL 的表——它存着全部邀请码。
  // 直接 UPDATE 在开发机（超级用户）上一路绿灯，一到生产就是 42501，
  // 而客户只看到「注册失败」，整个注册流程被那一行挡死。
  const service = await readFile(new URL("../lib/client-registration-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(service, /UPDATE\s+invitations/, "注册路径不得直接写 invitations");
  assert.match(service, /client_record_reusable_invitation_use/);

  const migration = await readFile(
    new URL("../postgres/migrations/0063_client_reusable_invitation_use_counter.sql", import.meta.url), "utf8");
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /kind = 'employee_reusable'/, "只作用于可复用链接，不得顶替一次性码的 used 语义");
  assert.match(migration, /GRANT EXECUTE ON FUNCTION/);

  // 最小权限不得被这次修复削弱：不许给客户端角色开 invitations 的表级权限。
  const roles = await readFile(new URL("../deploy/postgres/least-privilege-roles.sql", import.meta.url), "utf8");
  assert.doesNotMatch(roles, /GRANT[^\n]*\bON TABLE public\.invitations\b[^\n]*client/i);
  assert.match(roles, /client_record_reusable_invitation_use/);
});

test("生产环境的邀请链接不得带端口", async () => {
  // 容器里 Next 看到的是内网地址 http://<host>:3000/...，生产上请求永远带端口。
  // 「请求带端口就补端口」会发出 https://agentnovas.com:3000/... —— 客户端口不通，
  // 页面直接打不开，而链接看上去只是多了几个字符。
  const source = await readFile(new URL("../app/api/invitations/link/route.operations.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /if \(requestUrl\.port\) target\.port/, "不得以「请求带端口」作为补端口的判据");
  assert.match(source, /loopback/, "补端口的唯一判据是请求本身来自 loopback");
  assert.match(source, /127\.0\.0\.1/);
});
