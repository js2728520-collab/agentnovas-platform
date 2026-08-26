import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  assert.ok(results.length >= 8, "规则数量不应意外减少");
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

test("遗留清单为空——P4 之后仓库里没有需要围住的遗留代码", async () => {
  // 原来这里用「临时引用一个遗留模块，断言会被抓到」来验证机制有效。
  // P4 把遗留代码全部删除后清单空了，那个探针无从构造。
  //
  // 一个永远为空的规则等于永不报警，所以这条测试改成守住结论本身：清单是空的，
  // 且规则仍然在册。将来重新引入遗留件时，把探针加回来。
  const violations = await violationsOf("遗留代码不扩散");
  assert.deepEqual(violations, []);
  const checker = await readFile(new URL("../scripts/quality/check-architecture-boundaries.mjs", import.meta.url), "utf8");
  assert.match(checker, /const legacy = \{\}/, "清单应为空；若新增了条目，请把探针测试一并加回");
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

test("API 路由缺少 audience 后缀会被抓到", async () => {
  await withTemporaryFile(
    // withTemporaryFile 不建目录，探针必须落在已有目录里。
    "app/api/health/route.ts",
    "export async function GET() { return Response.json({}); }\n",
    async () => {
      const violations = await violationsOf("API 路由后缀与 audience 一致");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /缺少 audience 后缀/);
    },
  );
  assert.deepEqual(await violationsOf("API 路由后缀与 audience 一致"), []);
});

test("路由后缀与清单 audience 不一致会被抓到", async () => {
  // 把一个 client 路由伪装成 operations 路由：构建会把它放进运营端，
  // 而运行时 api-policy 只认清单里的 client——请求会在两层之间掉进缝里。
  await withTemporaryFile(
    "app/api/account/profile/route.operations.ts",
    "export async function GET() { return Response.json({}); }\n",
    async () => {
      const violations = await violationsOf("API 路由后缀与 audience 一致");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /未登记在 API inventory/);
    },
  );
  assert.deepEqual(await violationsOf("API 路由后缀与 audience 一致"), []);
});

test("Web 层解密交易所凭证会被抓到", async () => {
  // GA 打开实盘后，公网盒子被攻破一次 = 全部客户交易权限被拿走（ADR-0019）。
  await withTemporaryFile(
    "apps/client/ui/__boundary_probe__.ts",
    'import { decryptExchangeCredential } from "@/lib/exchange-credentials";\nexport const probe = decryptExchangeCredential;\n',
    async () => {
      const violations = await violationsOf("交易所凭证解密点收敛");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /decryptExchangeCredential/);
      assert.match(violations[0], /credential-access/);
    },
  );
  assert.deepEqual(await violationsOf("交易所凭证解密点收敛"), []);
});

test("执行边界之外引用凭证访问模块会被抓到", async () => {
  // 「收敛到一个模块」若允许任何人 import 它，等于没收敛。
  await withTemporaryFile(
    "lib/__boundary_probe__.ts",
    'export const probe = "@/lib/execution/credential-access";\n',
    async () => {
      const violations = await violationsOf("交易所凭证解密点收敛");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /只允许被 lib\/execution\/server\/ 内的模块使用/);
    },
  );
  assert.deepEqual(await violationsOf("交易所凭证解密点收敛"), []);
});

test("Web 层引用执行服务端模块会被抓到", async () => {
  // 这条与前两条查的不是同一件事。前两条查「谁能解密」，这条查「解密代码会不会被
  // 打进 Web 构建」——只要有人从 app/ import 了 lib/execution/server/ 下任意模块，
  // 打包器就会把整条依赖链连同解密一起塞回公网进程，而前两条一个都不会红。
  await withTemporaryFile(
    "apps/client/ui/__boundary_probe__.ts",
    'import { dispatchExecutionRequest } from "@/lib/execution/server/handler";\nexport const probe = dispatchExecutionRequest;\n',
    async () => {
      const violations = await violationsOf("交易所凭证解密点收敛");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /只能通过 lib\/execution\/client\.ts 发内网请求/);
    },
  );
  assert.deepEqual(await violationsOf("交易所凭证解密点收敛"), []);
});

test("Web 层加密交易所凭证会被抓到", async () => {
  // 只挡解密是不够的：AES-GCM 对称，能加密就能解密。Web 层为了保存凭证而持有
  // 密钥，等于它随时能还原全部客户的交易权限——解密代码不在构建里也没用。
  await withTemporaryFile(
    "apps/client/ui/__boundary_probe__.ts",
    'import { encryptExchangeCredential } from "@/lib/exchange-credentials";\nexport const probe = encryptExchangeCredential;\n',
    async () => {
      const violations = await violationsOf("交易所凭证解密点收敛");
      assert.equal(violations.length, 1);
      assert.match(violations[0], /加密与解密共用同一把对称密钥/);
    },
  );
  assert.deepEqual(await violationsOf("交易所凭证解密点收敛"), []);
});
