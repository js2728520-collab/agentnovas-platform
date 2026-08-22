import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { PERMISSION_DEFINITIONS } from "../lib/rbac.ts";

// 路由引用的每一个权限键都必须已注册。
//
// 由来：ops.trading.manage 被四条运维路由使用却从未登记，lib/access-control.ts 对
// 未注册的键抛 PERMISSION_UNKNOWN 500 —— 于是整套交易熔断在事故中挂不上。
// 更隐蔽的是导航项也用它做可见性判断，没有角色持有 ⇒ 入口永久隐藏，运营不会发现
// 它坏了。这类缺陷 fail-closed，不会造成越权，但会让安全刹车静默失效。
//
// 既有闸门查不到它：inventory 生成器只用正则收集键、不与定义表交叉校验；
// api-policy 测试只断言键非空。

const registered = new Set(PERMISSION_DEFINITIONS.map((permission) => permission.key));

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

async function collectReferencedKeys(roots) {
  const found = new Map();
  for (const root of roots) {
    for await (const file of sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/"((?:client|ops|maint)\.[a-z0-9_.]+)"/g)) {
        if (!found.has(match[1])) found.set(match[1], file);
      }
    }
  }
  return found;
}

test("路由与界面引用的权限键全部已注册", async () => {
  const referenced = await collectReferencedKeys(["app/api", "apps"]);
  const unknown = [...referenced.entries()]
    .filter(([key]) => !registered.has(key))
    .map(([key, file]) => `${key}（首次出现于 ${file}）`);
  assert.deepEqual(unknown, [], "未注册的权限键会让对应接口永久 500，且导航入口被隐藏");
});

test("ops.trading.manage 已注册且标记为敏感", () => {
  // 它能停掉全平台新开仓，也能批准真实下单，必须走近期 MFA。
  const definition = PERMISSION_DEFINITIONS.find((entry) => entry.key === "ops.trading.manage");
  assert.ok(definition, "交易熔断与实盘路由的权限键必须存在");
  assert.equal(definition.appId, "operations");
  assert.equal(definition.sensitive, true);
});

test("迁移里播种了这个键——只加进 TypeScript 常量不够", async () => {
  // PERMISSION_DEFINITIONS 是代码侧的清单，实际授权查的是数据库表。
  const migration = await readFile(
    new URL("../postgres/migrations/0054_ops_trading_manage_permission.sql", import.meta.url), "utf8");
  assert.match(migration, /INSERT INTO "permission_definitions"/);
  assert.match(migration, /ops\.trading\.manage/);
});
