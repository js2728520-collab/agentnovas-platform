import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import { checkArchitectureBoundaries } from "../scripts/quality/check-architecture-boundaries.mjs";

// 架构边界检查。
//
// 单人 + AI 协作没有 code review，文档写的边界挡不住「AI 很聪明地绕过去」。
// 这些规则是 CI 里会失败的检查。
//
// 本测试有两半，缺一不可：
//   1. 当前仓库零违例；
//   2. 每条规则确实能抓到违例 —— 一个从不报警的检查器等于没有。
// 第二半通过临时写入违例文件验证，try/finally 保证清理。

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function violationsOf(ruleName) {
  const results = await checkArchitectureBoundaries();
  const rule = results.find((entry) => entry.name === ruleName);
  assert.ok(rule, `未找到规则「${ruleName}」`);
  return rule.violations;
}

/** 临时写入一个违例文件，跑检查，无论成败都清理。 */
async function withTemporaryFile(relativePath, contents, assertion) {
  const absolute = join(repoRoot, relativePath);
  try {
    await writeFile(absolute, contents, "utf8");
    await assertion();
  } finally {
    await rm(absolute, { force: true });
  }
}

test("当前仓库通过全部架构边界检查", async () => {
  const results = await checkArchitectureBoundaries();
  const failures = results.flatMap((rule) => rule.violations.map((v) => `[${rule.name}] ${v}`));
  assert.deepEqual(failures, []);
  assert.ok(results.length >= 6, "规则数量不应意外减少");
});

test("跨 audience import 会被抓到", async () => {
  await withTemporaryFile(
    "apps/client/ui/__boundary_probe__.ts",
    'import { thing } from "@/apps/maintenance/ui/models-workspace";\nexport const probe = thing;\n',
    async () => {
      const violations = await violationsOf("跨 audience import");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /__boundary_probe__/);
      assert.match(violations[0], /apps\/maintenance/);
    },
  );
  assert.deepEqual(await violationsOf("跨 audience import"), [], "清理后应恢复为零违例");
});

test("绕过 ledger service 直接写资金表会被抓到", async () => {
  await withTemporaryFile(
    "lib/__boundary_probe__.ts",
    'export const sql = "INSERT INTO ledger_postings (id, amount) VALUES ($1, $2)";\n',
    async () => {
      const violations = await violationsOf("资金表唯一写入口");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /__boundary_probe__/);
      assert.match(violations[0], /commercial-ledger-service/);
    },
  );
  assert.deepEqual(await violationsOf("资金表唯一写入口"), []);
});

test("样式层写死色值会被抓到", async () => {
  await withTemporaryFile(
    "apps/client/ui/__boundary_probe__.module.css",
    ".probe {\n  color: #ff0000;\n}\n",
    async () => {
      const violations = await violationsOf("样式层零硬编码色值");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /__boundary_probe__\.module\.css:2/);
    },
  );
  assert.deepEqual(await violationsOf("样式层零硬编码色值"), []);
});

test("新引用遗留模块会被抓到", async () => {
  await withTemporaryFile(
    "apps/client/ui/__boundary_probe__.tsx",
    'import LocaleGuard from "@/app/locale-guard";\nexport default LocaleGuard;\n',
    async () => {
      const violations = await violationsOf("遗留代码不扩散");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /locale-guard/);
    },
  );
  assert.deepEqual(await violationsOf("遗留代码不扩散"), []);
});

test("域层里出现 I/O 会被抓到", async () => {
  await withTemporaryFile(
    "packages/domain/src/__boundary_probe__.ts",
    'import { Pool } from "pg";\nexport const probe = Pool;\n',
    async () => {
      const violations = await violationsOf("域层不做 I/O");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /__boundary_probe__/);
      assert.match(violations[0], /pg/);
    },
  );
  assert.deepEqual(await violationsOf("域层不做 I/O"), []);
});

test("域层直接调 fetch 会被抓到", async () => {
  await withTemporaryFile(
    "packages/domain/src/__boundary_probe__.ts",
    'export async function probe() {\n  return fetch("https://example.com");\n}\n',
    async () => {
      const violations = await violationsOf("域层不做 I/O");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /fetch/);
    },
  );
  assert.deepEqual(await violationsOf("域层不做 I/O"), []);
});

test("域层反向依赖 lib/ 会被抓到", async () => {
  await withTemporaryFile(
    "packages/domain/src/__boundary_probe__.ts",
    'import { getDb } from "@/lib/db";\nexport const probe = getDb;\n',
    async () => {
      const violations = await violationsOf("域层不做 I/O");
      assert.ok(violations.length >= 1);
      assert.match(violations.join(" "), /lib\//);
    },
  );
  assert.deepEqual(await violationsOf("域层不做 I/O"), []);
});
