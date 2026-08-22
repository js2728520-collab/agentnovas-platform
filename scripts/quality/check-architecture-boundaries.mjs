#!/usr/bin/env node
// 架构边界检查。
//
// 这个项目由单人 + AI 协作开发，没有第二双眼睛做 code review。文档里写的边界
// 挡不住「AI 很聪明地绕过去」——所以下面每条边界都必须是 CI 里会失败的检查。
//
// 每条规则都从「当前绿」开始：写入时仓库是零违例的。任何一条变红，说明有人
// （很可能是 AI）跨过了一条刻意划下的线，不是把规则改宽，而是要先问为什么。
//
// 用法：
//   node scripts/quality/check-architecture-boundaries.mjs
// 由 tests/architecture-boundaries.test.mjs 调用。

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".next", "dist", "outputs", "drizzle", "public",
]);

async function walk(directory, extensions, accumulator = []) {
  let entries;
  try {
    entries = await readdir(join(repoRoot, directory), { withFileTypes: true });
  } catch {
    return accumulator;
  }
  for (const entry of entries) {
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".next-")) continue;
      await walk(relativePath, extensions, accumulator);
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      accumulator.push(relativePath);
    }
  }
  return accumulator;
}

const readSource = (relativePath) => readFile(join(repoRoot, relativePath), "utf8");

/** 收集一个文件里的本地 import 目标（跳过第三方包）。 */
function localImports(source) {
  const targets = [];
  const pattern = /(?:import\s[^"']*from\s*|import\s*|require\(\s*)["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier.startsWith(".") || specifier.startsWith("@/")) targets.push(specifier);
  }
  return targets;
}

function resolveLocal(specifier, fromFile) {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  return relative(repoRoot, resolve(repoRoot, dirname(fromFile), specifier));
}

async function tryRead(basePath) {
  for (const candidate of [basePath, `${basePath}.tsx`, `${basePath}.ts`, `${basePath}/index.tsx`, `${basePath}/index.ts`]) {
    const source = await readSource(candidate).catch(() => null);
    if (source !== null) return { path: candidate, source };
  }
  return null;
}

// ---------------------------------------------------------------------------

const rules = [];

// 1. 跨 audience import。三端的产品边界必须在代码层面成立，
//    否则「三个应用」只是三个入口，不是三条边界。
rules.push(async function crossAudienceImports() {
  const violations = [];
  const pairs = [
    ["apps/client", ["apps/operations", "apps/maintenance"]],
    ["apps/operations", ["apps/client", "apps/maintenance"]],
    ["apps/maintenance", ["apps/client", "apps/operations"]],
  ];
  for (const [owner, forbidden] of pairs) {
    for (const file of await walk(owner, [".ts", ".tsx"])) {
      const source = await readSource(file);
      for (const specifier of localImports(source)) {
        const target = resolveLocal(specifier, file);
        const hit = forbidden.find((prefix) => target.startsWith(prefix));
        if (hit) violations.push(`${file} 引用了 ${hit} 的模块：${specifier}`);
      }
    }
  }
  return { name: "跨 audience import", violations };
});

// 2. 资金表写入口。数据库触发器保证 append-only 与借贷平衡，但挡不住
//    「在意料之外的地方写一笔平的但错的账」。写入口必须收敛。
rules.push(async function ledgerWriteSites() {
  const allowed = new Set(["lib/commercial-ledger-service.ts"]);
  const pattern = /insert\s+into\s+ledger_(transactions|postings)/i;
  const violations = [];
  for (const file of await walk("lib", [".ts"])) {
    if (allowed.has(file)) continue;
    if (pattern.test(await readSource(file))) {
      violations.push(`${file} 直接写 ledger 表；资金写入必须经 ${[...allowed][0]}`);
    }
  }
  return { name: "资金表唯一写入口", violations };
});

// 3. 根 layout 的包体污染。app/layout.tsx 被所有页面共享，从 "use client"
//    模块里 import 任何东西（哪怕只是一个常量）都会把整个模块及其依赖拖进
//    所有页面的公共包。客户端 JS 预算余量只有约 160 字节，这条踩了就爆。
rules.push(async function rootLayoutBundlePurity() {
  const file = "app/layout.tsx";
  const source = await readSource(file);
  const violations = [];
  for (const specifier of localImports(source)) {
    if (specifier.endsWith(".css")) continue;
    const resolved = await tryRead(resolveLocal(specifier, file));
    if (!resolved) continue;
    if (/^\s*["']use client["']/.test(resolved.source)) {
      violations.push(`${file} 引用了客户端模块 ${resolved.path}；请抽出无 React 的共享模块`);
    }
  }
  return { name: "根 layout 包体纯净", violations };
});

// 4. 遗留代码不得扩散。这些文件在 P4 之前不会消失，但引用点必须钉死，
//    否则遗留世界会持续长大，拆除成本越来越高。
rules.push(async function legacyContainment() {
  // P4 之后仓库里没有遗留代码了：client-app.tsx、globals.css、globals-beta.css、
  // LocaleGuard、market-terminal.css 全部删除，落地页样式也重写成了令牌驱动的
  // CSS Module。这张表因此是空的——机制保留，将来若再引入需要围住的遗留件，
  // 加一条 { "文件名": ["允许引用它的文件"] } 即可。
  const legacy = {};
  const violations = [];
  const sources = await walk("app", [".ts", ".tsx"]);
  sources.push(...await walk("apps", [".ts", ".tsx"]));
  sources.push(...await walk("packages", [".ts", ".tsx"]));

  for (const file of sources) {
    const source = await readSource(file);
    for (const [name, allowedImporters] of Object.entries(legacy)) {
      const referenced = localImports(source).some((specifier) => specifier.includes(name));
      if (referenced && !allowedImporters.includes(file)) {
        violations.push(`${file} 新引用了遗留模块 ${name}；遗留代码不应扩散`);
      }
    }
  }
  return { name: "遗留代码不扩散", violations };
});

// 5. 域层不做 I/O。这是 packages/domain 存在的全部意义：核心业务逻辑必须能在
//    没有数据库、没有网络、没有框架的环境里跑起来并被验证。一旦某个域模块开始
//    import pg 或 fetch，它就退回成了普通的 lib 文件。
rules.push(async function domainPurity() {
  // packages/ledger 同样是领域层：定点小数运算与借贷平衡校验必须能脱离数据库验证。
  const forbidden = [
    { pattern: /from\s+["']next(\/|["'])/, reason: "import 了 next" },
    { pattern: /from\s+["']pg["']/, reason: "import 了 pg" },
    { pattern: /from\s+["']drizzle-orm/, reason: "import 了 drizzle-orm" },
    { pattern: /from\s+["']node:(fs|net|http|https|dns|child_process)/, reason: "import 了 Node I/O 模块" },
    { pattern: /(^|[^.\w])fetch\s*\(/m, reason: "直接调用了 fetch" },
    { pattern: /\.\.\/\.\.\/\.\.\/lib\//, reason: "反向依赖了 lib/" },
    { pattern: /@\/lib\//, reason: "反向依赖了 lib/" },
  ];
  const violations = [];
  const pureRoots = ["packages/domain/src", "packages/ledger/src"];
  for (const root of pureRoots) {
    for (const file of await walk(root, [".ts", ".tsx"])) {
      const source = await readSource(file);
      for (const { pattern, reason } of forbidden) {
        if (pattern.test(source)) violations.push(`${file} ${reason}；域层需要外部数据时应定义端口，由基础设施层实现`);
      }
    }
  }
  return { name: "域层不做 I/O", violations };
});

// 6. 设计令牌是唯一色彩真源。新样式层里出现写死色值，说明有人绕过了令牌，
//    浅色/暗色双主题会在那个位置失效。
rules.push(async function noHardcodedColors() {
  const guarded = [
    "app/design-tokens.css",
    "app/base.css",
    "app/riverton-console.css",
    ...await walk("apps/client/ui", [".module.css"]),
  ];
  const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
  const violations = [];
  for (const file of guarded) {
    const source = await readSource(file).catch(() => null);
    if (source === null) continue;
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (literal.test(line)) violations.push(`${file}:${index + 1} 出现写死色值，请改用 --rv-* 令牌`);
    });
  }
  return { name: "样式层零硬编码色值", violations };
});

// 7. API 路由后缀必须与它的 audience 归属一致。
//    后缀决定该文件进哪个构建（next.config.ts 的 pageExtensions），清单决定运行时
//    放行哪个 audience。两者是两份真源——不一致就意味着「构建里有一条运行时拒绝的
//    路由」（浪费），或者更糟：「运行时允许但构建里没有」（404 找半天）。
rules.push(async function apiRouteAudienceSuffix() {
  const { API_ROUTE_INVENTORY } = await import("../../lib/api-route-inventory.ts");
  const SUFFIX_FOR = {
    "client": "client",
    "operations": "operations",
    "maintenance": "maintenance",
    "maintenance+operations": "internal",
    "client+maintenance+operations": "shared",
  };
  const audiencesBySource = new Map();
  for (const entry of API_ROUTE_INVENTORY) {
    const set = audiencesBySource.get(entry.source) ?? new Set();
    for (const audience of entry.audiences) set.add(audience);
    audiencesBySource.set(entry.source, set);
  }
  const pattern = /^route\.(client|operations|maintenance|internal|shared)\.ts$/;
  const violations = [];
  for (const file of await walk("app/api", [".ts"])) {
    const name = file.split("/").pop();
    if (!name.startsWith("route.")) continue;
    const match = pattern.exec(name);
    if (!match) {
      violations.push(`${file} 缺少 audience 后缀；API 路由必须显式声明归属（route.client.ts 等）`);
      continue;
    }
    const audiences = audiencesBySource.get(file);
    if (!audiences) {
      violations.push(`${file} 未登记在 API inventory；请运行 node scripts/generate-api-route-inventory.mjs`);
      continue;
    }
    const key = [...audiences].sort().join("+");
    const expected = SUFFIX_FOR[key];
    if (expected !== match[1]) {
      violations.push(`${file} 后缀为 .${match[1]}，但清单里的 audience 是 ${key}，应为 route.${expected}.ts`);
    }
  }
  return { name: "API 路由后缀与 audience 一致", violations };
});

// 8. 交易所凭证的解密点必须收敛。
//    凭证是 AES-GCM 密文内联存在 exchange_accounts，密钥来自环境变量——任何同时
//    拥有该变量与数据库读权限的进程都能解密全部客户的交易凭证。此前公网 Web 进程
//    正是这样一个进程。GA 打开实盘后，公网盒子被攻破一次 = 全部客户交易权限被拿走。
//    见 docs/adr/0019-ga-execution-service-and-key-custody.md。
rules.push(async function exchangeCredentialCustody() {
  // 允许解密的地方。research-exchange-account 跑在研发 Worker（独立进程），
  // 只取只读凭证算手续费；ADR-0019 的后续步骤会让它也走执行服务。
  const decryptImporters = new Set([
    "lib/execution/server/credential-access.ts",
    "lib/research-exchange-account.ts",
  ]);
  // 凭证访问模块只允许在执行边界内被引用——否则「收敛到一个模块」等于没收敛。
  const credentialAccessImporters = /^lib\/execution\/server\//;

  const violations = [];
  const sources = [
    ...await walk("app", [".ts", ".tsx"]),
    ...await walk("apps", [".ts", ".tsx"]),
    ...await walk("lib", [".ts"]),
    ...await walk("packages", [".ts", ".tsx"]),
    ...await walk("scripts", [".ts", ".mjs"]),
  ];
  // 检查器与它的测试自身会提到这些名字，跳过——否则规则永远红。
  const selfReferential = new Set([
    "scripts/quality/check-architecture-boundaries.mjs",
    // 这个检查器同样要提到被禁的函数名才能去构建产物里找它们。
    "scripts/quality/check-web-key-custody.mjs",
    "lib/exchange-credentials.ts",
  ]);
  const webLayer = /^apps?\//;
  // 加密与解密共用一把对称密钥：能加密就能解密。只挡解密而放行加密，Web 层照样
  // 需要持有密钥，「Web 层不能还原客户凭证」就仍然不成立。
  const encryptImporters = new Set(["lib/execution/server/account-binding.ts"]);
  for (const file of sources) {
    if (selfReferential.has(file)) continue;
    const source = await readSource(file);
    if (/encryptExchangeCredential/.test(source) && !encryptImporters.has(file)) {
      violations.push(`${file} 引用了 encryptExchangeCredential；加密与解密共用同一把对称密钥，只允许发生在 ${[...encryptImporters][0]}`);
    }
    if (/decryptExchangeCredential/.test(source) && !decryptImporters.has(file)) {
      violations.push(`${file} 引用了 decryptExchangeCredential；解密只允许发生在 ${[...decryptImporters][0]}`);
    }
    if (/execution\/credential-access/.test(source) && !credentialAccessImporters.test(file)) {
      violations.push(`${file} 引用了凭证访问模块；它只允许被 lib/execution/server/ 内的模块使用`);
    }
    // 第 2 步的核心约束：Web 层不得引用执行服务端代码。
    //
    // 前两条查的是「谁能解密」，这条查的是「解密代码会不会被打进 Web 构建」。
    // 少了这条，只要有人从 app/ import 了 lib/execution/server/ 下任意模块，
    // 打包器就会把整条依赖链——包括解密——重新塞回公网进程，而前两条一个都不会红。
    if (webLayer.test(file) && /lib\/execution\/server\//.test(source)) {
      violations.push(`${file} 引用了执行服务端模块；Web 层只能通过 lib/execution/client.ts 发内网请求`);
    }
  }
  return { name: "交易所凭证解密点收敛", violations };
});

// ---------------------------------------------------------------------------

export async function checkArchitectureBoundaries() {
  const results = [];
  for (const rule of rules) results.push(await rule());
  return results;
}

async function main() {
  const results = await checkArchitectureBoundaries();
  let failed = 0;
  for (const { name, violations } of results) {
    if (violations.length === 0) {
      process.stdout.write(`  ✓ ${name}\n`);
      continue;
    }
    failed += violations.length;
    process.stdout.write(`  ✗ ${name}（${violations.length} 处）\n`);
    for (const violation of violations) process.stdout.write(`      ${violation}\n`);
  }
  if (failed) {
    process.stderr.write(`\n架构边界检查失败：${failed} 处违例。\n`);
    process.stderr.write("这些边界是刻意划下的。先问为什么会跨过去，不要直接把规则改宽。\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`\n架构边界检查通过（${results.length} 条规则）。\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
