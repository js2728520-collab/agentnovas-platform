import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { API_ROUTE_INVENTORY } from "../lib/api-route-inventory.ts";
import { rulesFor, segmentsOf, PARAM } from "../scripts/generate-nginx-api-allowlist.mjs";

// Nginx /api 白名单。
//
// 三个应用编译同一份 API 面，应用层的 fail-closed 校验是唯一边界。这层把跨端请求
// 挡在 Node 之外，作为纵深防御的第一层。本测试保证两件事：
//   1. 生成的白名单与 inventory 同步（加了路由忘了重新生成会失败）；
//   2. 白名单既不放行任何一条该 audience 无权的路由，也不误拦合法路由。
//
// 注意：本测试不验证 Nginx 语法。生成的是 map 指令，语法正确性需要在部署前用
// `nginx -t` 验证——本仓库的 CI 环境没有 nginx。

const execFileAsync = promisify(execFile);
const AUDIENCES = ["client", "operations", "maintenance"];

/** 把带参数的路由变成一条具体路径，用于匹配测试。 */
function concretePath(route) {
  return "/" + segmentsOf(route).map((segment) => (segment === PARAM ? "sample-id" : segment)).join("/");
}

function matcherFor(audience) {
  const { prefixes, exacts } = rulesFor(audience);
  const patterns = [
    ...prefixes.map((rule) => new RegExp(`^${rule}(/|$)`)),
    ...exacts.map((rule) => new RegExp(`^${rule}$`)),
  ];
  return (path) => patterns.some((pattern) => pattern.test(path));
}

test("生成的白名单与 API inventory 同步", async () => {
  await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "scripts/generate-nginx-api-allowlist.mjs", "--check"],
    { cwd: new URL("..", import.meta.url) },
  );
});

test("白名单不放行任何一条该 audience 无权的路由", () => {
  for (const audience of AUDIENCES) {
    const allowed = matcherFor(audience);
    const leaks = new Set();
    for (const entry of API_ROUTE_INVENTORY) {
      if (entry.audiences.includes(audience)) continue;
      if (allowed(concretePath(entry.route))) leaks.add(entry.route);
    }
    assert.deepEqual([...leaks], [], `${audience} vhost 越权放行了这些路由`);
  }
});

test("白名单不误拦该 audience 的合法路由", () => {
  for (const audience of AUDIENCES) {
    const allowed = matcherFor(audience);
    const blocked = new Set();
    for (const entry of API_ROUTE_INVENTORY) {
      if (!entry.audiences.includes(audience)) continue;
      if (!allowed(concretePath(entry.route))) blocked.add(entry.route);
    }
    assert.deepEqual([...blocked], [], `${audience} vhost 误拦了这些合法路由`);
  }
});

test("公网客户端 vhost 挡住内部管理接口", () => {
  const allowed = matcherFor("client");
  // 前缀粒度合并曾让这些 RBAC 管理接口对公网 vhost 可达，是改用前缀树的原因。
  const mustBlock = [
    "/api/access/roles",
    "/api/access/roles/sample-id/publish",
    "/api/access/assignments",
    "/api/access/change-requests/sample-id/decisions",
    "/api/access/audit",
    "/api/maintenance/system-health",
    "/api/admin/llm-profiles",
    "/api/system/bootstrap",
    "/api/operations/deposits",
    "/api/integrations/resend/webhook",
  ];
  for (const path of mustBlock) {
    assert.equal(allowed(path), false, `客户端 vhost 不应放行 ${path}`);
  }
  // 客户端自身需要的两条必须仍然通过。
  assert.equal(allowed("/api/access/me/effective"), true);
  assert.equal(allowed("/api/trading-hall/paper/portfolio"), true);
});

test("主配置引入生成文件并在每个 vhost 加了边缘拒绝", async () => {
  const conf = await readFile(new URL("../deploy/nginx/riverton-three-apps.conf", import.meta.url), "utf8");
  for (const audience of AUDIENCES) {
    assert.match(
      conf,
      new RegExp(`include\\s+\\S*generated/${audience}-api-allowlist\\.conf;`),
      `主配置缺少 ${audience} 白名单的 include`,
    );
    assert.match(
      conf,
      new RegExp(`if \\(\\$riverton_${audience}_api_denied\\) \\{ return 404; \\}`),
      `${audience} 的 location / 缺少边缘拒绝`,
    );
  }
  // 拒绝用 404 而不是 403：与应用层 ROUTE_NOT_AVAILABLE 一致，不泄露接口在别处存在。
  assert.doesNotMatch(conf, /api_denied\) \{ return 403/);
});
