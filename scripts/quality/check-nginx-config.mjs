/**
 * 用真实 nginx 校验 deploy/nginx 下的配置。
 *
 * 为什么要有这个脚本：这份配置在仓库里躺了很久，**从未被 `nginx -t` 跑过一次**。
 * 它是三个应用之间的第一道隔离（每个 vhost 的 /api 白名单），一个语法错误会让
 * 整个站点起不来，而且只会在部署当天才发现。
 *
 * 两个必须做对的细节：
 *
 * 1. **必须提供证书文件。** 缺证书时 nginx 会停在第一个 server 块，后面的语法一条
 *    都验不到——那样的「通过」毫无意义。这里用一次性自签证书顶替 Let's Encrypt 的
 *    路径。
 * 2. **警告与错误分开报。** 当前配置有 8 条 `listen ... http2` 弃用警告，
 *    但**不应该**改成 `http2 on;`：那个指令要求 nginx ≥ 1.25.1，而 Ubuntu 22.04
 *    (1.18)、Ubuntu 24.04 (1.24)、Debian 12 (1.22) 都更旧，在那里它是致命错误。
 *    nginx 跑在宿主机上而不是容器里，版本由发行版决定。
 *    新版本上的一条警告，好过旧版本上的起不来。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = process.env.NGINX_CHECK_IMAGE || "nginx:1.29.8-alpine";
const CONFIG_DIR = "deploy/nginx";

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerAvailable() {
  try {
    run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

export function checkNginxConfig() {
  const workdir = mkdtempSync(join(tmpdir(), "rv-nginx-"));
  try {
    cpSync(CONFIG_DIR, join(workdir, "riverton"), { recursive: true });

    // 只加载被测配置，其余用官方默认，避免默认站点的规则混进来。
    writeFileSync(join(workdir, "nginx.conf"), [
      "events { worker_connections 1024; }",
      "http {",
      "  include /etc/nginx/mime.types;",
      "  default_type application/octet-stream;",
      "  include /etc/nginx/riverton/riverton-three-apps.conf;",
      "}",
      "",
    ].join("\n"));

    const certDir = join(workdir, "certs", "live", "agentnovas.com");
    mkdirSync(certDir, { recursive: true });
    run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", join(certDir, "privkey.pem"),
      "-out", join(certDir, "fullchain.pem"),
      "-subj", "/CN=agentnovas.com",
    ]);

    // nginx -t 把结果和警告都写到 stderr，因此必须两条流都收。
    // 只收 stdout 会让警告全部丢失，而丢失警告的检查器看起来永远很干净。
    const run_ = spawnSync("docker", [
      "run", "--rm",
      "-v", `${join(workdir, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
      "-v", `${join(workdir, "riverton")}:/etc/nginx/riverton:ro`,
      "-v", `${join(workdir, "certs")}:/etc/letsencrypt:ro`,
      IMAGE, "nginx", "-t", "-c", "/etc/nginx/nginx.conf",
    ], { encoding: "utf8" });
    const ok = run_.status === 0;
    const combined = `${run_.stdout ?? ""}${run_.stderr ?? ""}`.replace(/^.*docker-entrypoint.*$/gm, "");
    const warnings = [...new Set(combined.split("\n").filter((line) => line.includes("[warn]")))];
    const errors = combined.split("\n").filter((line) => line.includes("[emerg]") || line.includes("[error]"));
    return { ok: ok && errors.length === 0, warnings, errors, image: IMAGE };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function main() {
  if (!dockerAvailable()) {
    // 不静默通过：一个「查不了就算过」的闸门等于没有闸门。
    process.stderr.write(
      "Docker 不可用，无法校验 nginx 配置。\n" +
      "这不是通过——部署前必须在一台有 Docker 或有 nginx 的机器上跑一次本检查。\n",
    );
    process.exitCode = 2;
    return;
  }
  const result = checkNginxConfig();
  process.stdout.write(`使用镜像 ${result.image}\n`);
  for (const warning of result.warnings) {
    process.stdout.write(`  ⚠ ${warning.replace(/^nginx: /, "").trim()}\n`);
  }
  if (result.warnings.length) {
    process.stdout.write(
      "\n上述 listen ... http2 弃用警告是刻意保留的：改成 http2 on; 需要 nginx ≥ 1.25.1，\n" +
      "而 Ubuntu 22.04/24.04 与 Debian 12 都更旧，在那里它是致命错误。nginx 跑在宿主机上，\n" +
      "版本由发行版决定。新版本上的一条警告，好过旧版本上的起不来。\n",
    );
  }
  if (!result.ok) {
    for (const line of result.errors) process.stderr.write(`  ✗ ${line.trim()}\n`);
    process.stderr.write("\nnginx 配置语法错误。这份配置是三端隔离的第一道，错了整个站点起不来。\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nnginx 配置语法校验通过。\n");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
