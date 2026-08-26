/**
 * 校验三个 Web 构建产物里不含交易所凭证的加解密能力（ADR-0019 第 2 步的验收标准）。
 *
 * 为什么要查构建产物而不是只查源码：架构边界规则查的是「谁写了 import」，
 * 但把解密拉回 Web 层的方式不止直接 import 一种——多一条间接依赖、一次
 * re-export、一个看起来无害的工具模块，都能让打包器把整条链塞回公网进程。
 * 唯一说了算的是构建出来的东西。
 *
 * 加密与解密都查：AES-GCM 对称，能加密就能解密。只查解密会漏掉「Web 层为了保存
 * 凭证而持有密钥」这条同样致命的路径。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const FORBIDDEN = [
  "EXCHANGE_CREDENTIAL_ENCRYPTION_KEY",
  "decryptExchangeCredential",
  "encryptExchangeCredential",
];

const AUDIENCES = ["client", "operations", "maintenance"];

async function* jsFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 该 audience 尚未构建
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    // .js.map 是 source map，含原始文件名属正常，不作为违例。
    else if (entry.name.endsWith(".js")) yield full;
  }
}

export async function checkWebKeyCustody() {
  const violations = [];
  const checked = [];
  for (const audience of AUDIENCES) {
    const dir = `.next-${audience}/server`;
    let files = 0;
    for await (const file of jsFiles(dir)) {
      files += 1;
      const source = await readFile(file, "utf8");
      for (const needle of FORBIDDEN) {
        if (source.includes(needle)) violations.push(`${file} 含 ${needle}`);
      }
    }
    checked.push({ audience, files });
  }
  return { violations, checked };
}

async function main() {
  const { violations, checked } = await checkWebKeyCustody();
  const missing = checked.filter((entry) => entry.files === 0).map((entry) => entry.audience);
  if (missing.length) {
    process.stderr.write(`未找到构建产物：${missing.join("、")}。请先 npm run build:<audience>。\n`);
    process.exitCode = 1;
    return;
  }
  for (const { audience, files } of checked) {
    process.stdout.write(`  ✓ ${audience}（扫描 ${files} 个 .js）\n`);
  }
  if (violations.length) {
    process.stdout.write("\n");
    for (const violation of violations) process.stderr.write(`  ✗ ${violation}\n`);
    process.stderr.write(
      "\nWeb 构建里出现了交易所凭证的加解密能力。\n" +
      "这不是代码风格问题：公网进程一旦持有那把对称密钥，被攻破一次等于全部客户的\n" +
      "交易权限被拿走。请把相关调用移回执行服务（lib/execution/server/），\n" +
      "Web 层只能通过 lib/execution/client.ts 发内网请求。见 docs/adr/0019。\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n三端 Web 构建均不含交易所凭证加解密能力。\n");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
