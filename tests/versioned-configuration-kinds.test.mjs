import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { CONFIGURATION_KINDS } from "../lib/versioned-configuration-domain.ts";
import { configurationKinds } from "../apps/maintenance/ui/configuration-version-ui.ts";

test("配置类型有三份副本，必须完全一致", async () => {
  // 真源是数据库的 CHECK 约束：应用少一个类型，那个配置族就根本无法被创建（T2.1c 的
  // market 就这样落在了 DB 允许但 API 拒绝的缝里）；应用多一个，则要到 INSERT 时才
  // 炸成 23514。UI 那份是刻意的第二副本——从 lib 里 import 值会把家族注册表和错误类型
  // 拖进客户端包。
  const directory = new URL("../postgres/migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  let allowed = null;
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), "utf8");
    // 最后一次定义该约束的迁移才是当前状态。
    for (const match of sql.matchAll(/configuration_versions_kind_check\s*\n?\s*CHECK \(kind IN \(([^)]*)\)\)/g)) {
      allowed = [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]);
    }
  }
  assert.ok(allowed, "未能从迁移里解析出 configuration_versions_kind_check");

  assert.deepEqual([...CONFIGURATION_KINDS].sort(), [...allowed].sort(),
    "应用侧 CONFIGURATION_KINDS 与数据库 CHECK 不一致");
  assert.deepEqual([...configurationKinds].sort(), [...allowed].sort(),
    "运维端下拉框的配置类型与数据库 CHECK 不一致");
});
