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
  const legacy = {
    "globals-beta.css": ["app/audience/client-workspace-root.tsx", "app/audience/client-landing-root.tsx"],
    "market-terminal.css": ["app/audience/client-workspace-root.tsx"],
    "membership-center.css": ["app/audience/client-workspace-root.tsx"],
    "locale-guard": ["app/audience/client-workspace-root.tsx"],
    "client-app": ["apps/client/ui/client-app.tsx", "apps/client/ui/client-workspace-loader.tsx"],
  };
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
