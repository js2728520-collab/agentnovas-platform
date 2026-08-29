# Controlled Beta quality evidence runner

> 文档状态：`CURRENT_BASELINE`。本证据 runner 证明当前受控 Beta，不证明真实交易、资金出站或 CI/CD 触发安全；V3 每个阶段需在 [`FULL_PLATFORM_V3_GATES.md`](FULL_PLATFORM_V3_GATES.md) 基础上扩展并重新生成证据。

状态：已集成并在 2026-08-21 当前工作树完成最终本地重跑；证据目录为被 Git 忽略的 `outputs/`，发布提交变化后必须重新生成。

This runner creates repeatable release evidence without contacting a payment provider, an email provider, a Demo exchange, or any other external host. It resolves only approved direct test dependencies and never downloads tools at runtime.

## Package and script integration

仓库已经锁定以下直接开发依赖：

- `@playwright/test@1.62.1`
- `@axe-core/playwright@4.13.0`
- `@lhci/cli@0.15.1`

仓库已经提供以下脚本：

```json
{
  "test:e2e": "node scripts/quality/run-e2e.mjs",
  "test:e2e:mfa-on": "node scripts/quality/run-mfa-on-e2e.mjs",
  "test:e2e:mfa-rollout": "node --experimental-strip-types scripts/quality/run-mfa-rollout-e2e.mjs",
  "test:e2e:direct": "playwright test",
  "quality:bundle": "node scripts/quality/check-next-bundle-budget.mjs",
  "quality:lighthouse": "node scripts/quality/run-lighthouse.mjs",
  "quality:release": "node scripts/quality/verify-release-evidence.mjs"
}
```

The wrappers resolve only `node_modules/.bin` binaries. Missing dependencies fail explicitly, so a developer machine cannot silently use an unrelated global package or fetch one through `npx`.

## Local prerequisites and commands

- Use the repository-supported Node 22 release.
- Run a local PostgreSQL server. Set `QUALITY_E2E_DATABASE_URL` to a loopback PostgreSQL database URL. Non-loopback URLs are rejected.
- Build all three applications before production-mode browser and Lighthouse runs: `npm run test:apps`.
- Install Chromium once from the locked Playwright package: `./node_modules/.bin/playwright install chromium`. This is setup, not part of the evidence run.
- If the standard local ports are occupied, set a bounded integer `QUALITY_E2E_PORT_OFFSET` (for example `100` for ports 3100–3102). The default remains the production topology at 3000–3002.

Run the gates in this order:

```text
node --test tests/e2e/*.unit.test.mjs tests/e2e/*.postgres.test.mjs
npm run test:e2e
npm run test:e2e:mfa-on
npm run test:e2e:mfa-rollout
npm run quality:bundle
npm run quality:lighthouse
npm run quality:release
```

The browser run uses one disposable `quality_e2e_*` PostgreSQL schema. It migrates the schema from scratch and creates four primary synthetic identities plus a dedicated Client security identity: Client, Client security, Operations maker, Operations checker, and Maintenance admin. Each wrapper first removes its prior output directory, then recreates it under the repository `outputs/` boundary so a previous run cannot contaminate the current manifest. Before deletion it rejects a symbolic link at the repository root, `outputs/`, any intermediate component, or the target; resolves the existing path into the real repository boundary; and immediately repeats those checks before deleting only the controlled real target. A symlink or realpath escape therefore fails without touching an external target. The wrapper always deletes storage states/passwords/tokens in a `finally` path, even when dropping the schema fails. Cleanup evidence then records the real, redacted failure phase and the command exits unsuccessfully; a failed schema drop can never leave the runtime secret directory behind or produce passing cleanup evidence.

All external-effect switches are forced off, including `PAYMENT_PROVIDER_TESTS_ENABLED`, `PLATFORM_DEMO_VERIFICATION_ENABLED`, and `PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED`. Provider credentials are scrubbed from the child environment, and Playwright requests are aborted unless their URL is loopback or one of the three official app hosts. Playwright maps exact official HTTPS hosts to the matching loopback server while preserving the upstream Host and secure audience Cookie. Lighthouse uses a loopback audit URL so local TLS cannot create false failures, but its runner-owned proxy rewrites the upstream Host to the official Client audience and permits only exact read-only loopback traffic; every other host, method, or tunnel is rejected. Service workers are blocked, and the application server process receives a dead local proxy for all other traffic. No payment, notification, research, runtime, or Demo worker is started.

The canonical `test:e2e` run forces `MFA_ENFORCEMENT_ENABLED=false` so it matches the current rollout policy. `test:e2e:mfa-on` uses a separate disposable schema for the enabled-state login, reset and recent-MFA path. `test:e2e:mfa-rollout` restarts all three standalone applications against one disposable schema through `true → false → true`; it proves that disabled-state sessions cannot bypass a later re-enable and that credentials remain usable. Production enablement still requires the target-environment ADR-0023 gate.

## Covered evidence

- strict Host and audience rejection, audience-specific cookie isolation, and production cookie attributes;
- 三端当前关闭态密码登录直接进入完整会话且不出现 MFA 挑战；本地开启态覆盖三端绑定/验证、TOTP/recovery、Client/Operations 密码重置、recent MFA 过期和同库开→关→开；目标环境仍需单独复验；
- Operations 权限链接浏览器注册、冻结角色/scope、手动作废和旧链接拒绝；
- Client 五浏览器设备、第六台拒绝、跨上下文全量退出，以及 Email send 关闭时加密 outbox 降级；
- the synthetic Client order → maker evidence/submit → maker denial → checker approval/replay path;
- legal-document acceptance, one membership activation, 1,000 credits, and exactly three isolated 10,000 USDT paper portfolios;
- Operations PII masking and recursive public-payload checks for raw credential fields;
- four identity-specific application pages at 320, 768, 1024, and 1440 pixels;
- serious/critical axe violations, keyboard entry, horizontal overflow, browser console/page errors, failed local requests, and denied external requests;
- three application initial JS/CSS gzip budgets from Next build manifests;
- three-run Client login Lighthouse thresholds for LCP, CLS, TBT, accessibility, best practices, and resource size;
- a final hash manifest that accepts only an unfiltered fifteen-test E2E run, including empty-browser login through all three applications, three passing bundle reports, three distinct existing Lighthouse JSON reports independently revalidated for scores, timings and non-empty script/stylesheet/image evidence, and complete cleanup evidence.

Traces, videos, and screenshots are disabled because the MFA enrollment page temporarily renders a TOTP setup key and recovery codes, while binary screenshots cannot be reliably secret-scanned. Next servers bind explicitly to `127.0.0.1`. Bounded, redacted console/network summaries are retained. The final verifier rejects retained `.runtime` directories and all standalone binary-image artifacts, then scans textual evidence for the fixture password/token canaries and cookie/authorization material. Lighthouse starts from an empty output directory and the release verifier accepts exactly the three distinct reports named by the current run's manifest.

## CI job requested from the CI owner

Create a separate `quality-release` job with PostgreSQL 16 and Node 22. It must run only after ordinary unit/type/lint/inventory/diff gates and use this sequence:

1. `npm ci`
2. `./node_modules/.bin/playwright install --with-deps chromium`
3. `npm run test:apps`
4. Set `QUALITY_E2E_DATABASE_URL` to the job-local PostgreSQL service and explicitly set all payment/email/Demo/research/runtime switches to `false`.
5. `npm run test:e2e`
6. `npm run quality:bundle`
7. `npm run quality:lighthouse`
8. `npm run quality:release`
9. Always upload `outputs/` for 7–14 days, excluding any `.runtime` directory. Do not configure provider secrets for this job.

Network egress should be denied at the CI job/container boundary as the authoritative control. The in-process route and proxy controls are defense in depth, not a substitute for an infrastructure egress policy.

The implementation follows the official Playwright guidance for [web servers](https://playwright.dev/docs/test-webserver), [projects](https://playwright.dev/docs/test-projects), [network interception](https://playwright.dev/docs/network), [blocked service workers](https://playwright.dev/docs/service-workers), and [axe accessibility tests](https://playwright.dev/docs/accessibility-testing), plus the official [Lighthouse CI configuration reference](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md).

## Current release status and external boundary

- CI `quality-release` job 已集成；基础设施级 egress deny、生产 DNS/TLS 和真实外部 provider smoke 仍由部署环境负责。
- 当前 lockfile 的三端初始 JS/CSS gzip：Client 204,739/16,263 bytes，Operations 193,125/11,660 bytes，Maintenance 193,304/11,660 bytes，均通过 200/50 KiB 预算。Client 距 JS 上限仅 61 bytes，后续任何前端变更都必须重新测量，不能沿用本次结论。
- 2026-08-26 r4 preview 候选的 20 个 canonical Playwright 场景使用合成身份与四档 viewport，覆盖三端空浏览器登录、Host/Cookie audience 隔离、权限链接、五设备/全量退出、会员 maker-checker、Client/Operations/Maintenance 稳定路由、客户 PII 原因审计、Client 工作记录、Maintenance AI 用量/工作记录导出、axe 和 console/network；20/20 通过，外部写入为 false，质量 schema 与 runtime secrets 已清理。另有 MFA-on 3/3 与同库 rollout 9 旅程的既有专项证据。
- 同一 r4 源码在未人为限制宿主 CPU、1 GiB shm 的隔离 runner 中完成三次 Lighthouse。三次 performance 为 0.97/0.96/0.98，accessibility 与 best practices 均为 1.00；LCP 1805/2431/1785 ms，CLS 均为 0，TBT 167/151/148 ms。代表运行 JS/CSS/image transfer 为 177,513/18,098/10,166 bytes，全部满足 Gate 预算。一个先行的 2 CPU 人工上限 runner 因 TBT 325–441 ms 失败，该结果保留为编排条件证据，不计作通过；取消额外 CPU cap 后的标准三次运行才是当前发布 Gate。
- 最新恢复演练于 2026-08-27 在 `an-saas` 由专用 `agentnovas_migrator` 对隔离 fresh PostgreSQL 16.14
  源库执行，覆盖截至 `0086` 的 87 个迁移和 185 张基础表。custom dump restore、迁移 registry checksum
  与表集合均通过，恢复目标标记 `retained: false`，一次性源库、恢复目标和临时 PostgreSQL 客户端 volume
  均已清理；migrator 的 `CREATEDB` 临时能力也已撤销。`pg_dump --enable-row-security` 未使用
  `BYPASSRLS`；实盘仍由 `isLiveExecutionReady()` 关闭，演练未执行真实商户请求或资金操作。该证据只对
  截至 `0086` 的当前
  迁移集合有效；新增、改名或 checksum 变化会自动使恢复 Gate 失效，必须重跑，不能手工递增数字。
- 本 runner 验证角色模板、Client Web/Auth 攻击矩阵和隔离测试，但不替代目标环境的进程角色 smoke。每次部署仍须从 Client 两条连接及 Operations、Maintenance、各 Worker、payment webhook、migrator 的实际 secret/env 执行 `SELECT current_user` 并保存脱敏结果；不得记录连接串或口令。
- r4 preview 已补做目标环境进程角色 smoke：Client Web/Auth、Operations Web、Maintenance Web、payment webhook、migrator 六条实际连接分别返回 `agentnovas_client_web`、`agentnovas_client_auth`、`agentnovas_ops_web`、`agentnovas_maint_web`、`agentnovas_payment_webhook`、`agentnovas_migrator`。三端容器以 `node` 用户、只读根文件系统、`cap_drop=ALL`、`no-new-privileges` 运行，只把 3000 映射到宿主 `127.0.0.1:3200–3202`；各自 env 以只读 bind mount 挂载，普通容器环境中敏感键为 0。backplane 为 internal，Web 只连接 backplane/edge；未启用 Worker profile 时 egress 网络不创建，四份 Worker env 没有数据库连接且运行实例为 0。preview 与 production PostgreSQL 的容器 ID、数据卷和 backplane 均不同。脱敏证据保存在 r4 release 的 `security-runtime-audit-final.log`，SHA-256 为 `105bccc77e9da808eda6a9876568d5d6265de46b96796d125c193c0a143981af`。
- 开发依赖停止项关闭后，三域已刷新到 `preview-7c047b6-wt-20260826T161203Z`。四镜像均绑定 source hash `e5c9acbf9d741922e7984686066b2f99c6c5678840553e0d309e1afb26f64f47`；Web 容器继续保持 non-root/read-only/cap-drop/no-new-privileges、普通敏感 env 0、仅 backplane/edge、Worker 0。初始 HTTPS/Host smoke 9/9 为 200、12 个错误/cross-audience Host 为 404；随后 10 个采样点的 60/60 live/ready 为 200，p95 172 ms、最大 241 ms，0 restart/app error/Caddy 5xx。preview registry 的 78 条包含第 84 节已登记的旧候选历史行，当前源码 77 个迁移且无 source-only 缺口；没有修改 registry 或 production。
- 真实 Email、Demo、Payment、交易或 DNS/TLS smoke 不属于本 runner。没有凭证时产品以 `not_configured/configured_not_sent/disabled` 安全降级；若决定启用，必须在独立 staging 记录中补充真实 provider 证据。
- r4 首轮 canary 的精确启用范围见 `docs/releases/2026-08-26-r4-preview-capability-manifest.md`：允许三端受控 Web、站内通知、已持久化 Paper/工作记录和 Operations/Maintenance 管理面；所有真实 provider 与外部 Worker均关闭。数据库虽然有 8 个启用 LLM Profile 和 10 个绑定，但没有 r4 真实 provider smoke，因此只开放 Profile/绑定管理，不把真实模型推理纳入 canary。

## Development-tool vulnerability exception closed

2026-08-27 已关闭原 17 项开发工具链临时例外。lockfile 通过受控 override 使用 `esbuild 0.28.2`、
`lighthouse 13.4.1`、`tmp 0.2.7` 和 `uuid 11.1.1`；`extract-zip` 不再存在。没有采用
`npm audit fix --force` 提议的 `drizzle-kit 0.18.1` / `@lhci/cli 0.1.0` 破坏性降级。

- 完整 `npm audit --audit-level=low`：0 vulnerability；production 子集因此同样为 0。
- Node 22.21.1 隔离 PostgreSQL 全量测试：1449/1449；并发角色隔离复现 4 路均 5/5。
- TypeScript、ESLint、8 条架构边界通过；三端 production build 和 Bundle Gate 通过。
- canonical Chromium/axe 20/20；Lighthouse 13.4.1 三次采样通过，代表运行 performance 0.96、accessibility 1.00、best practices 1.00、LCP 2436 ms、CLS 0、TBT 162 ms。
- `quality:release` 已重新组合并验证 E2E、Bundle、Lighthouse 与 cleanup 证据；`externalWritesEnabled=false`。

证据位于 `an-saas:/opt/agentnovas-riverton-preview/validations/audit-zero-20260826T1532Z/`；完整审计、
全量测试、E2E、Lighthouse、release manifest 的 SHA-256 分别为
`df33ebcb533ac533badec1ea3e65ed6fdd36b1bd20dde21e75e5b729abb7d9cd`、
`69b3f5bf158ba36b84c7da8f40086570df39688e7a6484aa2c512f13f5d21d7a`、
`ebb325da72224acf8f9ae5239b0ec4f2cf6566edb4ffb39e3d9ada0fd1e6e887`、
`fe42c6263b0c43b5bc5cc8a32b8777502d4919592f38b5ff06b214905dfe24d6`、
`3893360bdd778bf94d6911407174bfb63709b8d4e7e23af9e30eba5680b80179`。原 2026-08-28 / 首个付费
Beta 前停止条件已满足并关闭；这不替代 T9.5 人员演练或 production 发布授权。

## M1 三端极简安全版测试站证据（2026-08-29）

当前测试站不可变版本为 `preview-m1-s5-20260829-visual1`，只部署到
`test.agentnovas.com`、`ops-test.agentnovas.com` 和 `main-test.agentnovas.com`。三个 Web 容器均
healthy、restart=0；公开登录页为 200，错误 Host 直达为 404。数据库容器未重启，数据卷保持
`agentnovas-riverton-preview-pg-m1-s3-20260829-preferences1`。

- 三端 image ID：Client `sha256:e2f0f27bf590e55dd4d07462fe337a11fe10a5f6dddeb98be19e1a164464c741`；Operations
  `sha256:710fde35f954ead1bc9e5cfdd66e419b6f34b6c17181f4003f0a9bd2391e5262`；Maintenance
  `sha256:a7b20f619de1ec71d5b813d9dc0b09e306a5cfb8c3e163f604b4025df1f625e3`。
- image build / inspect SHA-256：
  `5a506cd3c4e0b143b9ebf1c9a793f616857d1eb75c675912e3bf664d18ad926e` /
  `d2e6e30dae8576883d1eab5fd8d4cb60697083f3fbf500e3dc4bdaff90b01ae7`。
- Node 22.21.1 + 隔离 PostgreSQL 全量 `1639/1639`，日志 SHA-256
  `ca2d6262312f11b4341dd5925d890adb24a89fd81a5bc17acf7a45a2490f2076`；TypeScript、完整 ESLint、
  8 条架构边界与三端 key custody 日志 SHA-256
  `64dd660d1b06d81aec70bd64d1fa53549c8d94452e720792cbbd82e920ec4fd4`。仓库 secret scan 覆盖 3286
  个 tracked/untracked candidate，零 finding。
- PostgreSQL 角色策略 `findings: []`，证据 SHA-256
  `23e1445af2cc6f5b32602a1b221cf2b28f99f7347d21b75ef8bbf9800b52ec88`。
- Playwright 报告 SHA-256
  `6e799245203fc7d62e69f424271152264667a86abf735eea0ed85b065897a5fc`，含 18 张三端六主题截图；覆盖
  320/768/1024/1440、严重/关键 axe、无横向溢出、五入口、通知、偏好恢复、设置 Tab、Host/Cookie
  audience 隔离。三端未知外部请求、凭证 URL、应用 console/page error 与失败响应均为 0。

Cloudflare edge 会为浏览器 UA 注入 `static.cloudflareinsights.com` beacon，并产生 SRI warning；测试 runner
只对该单一已识别 edge 请求返回空脚本、单独计数，不把它混入应用外部请求。关闭该注入需要 Cloudflare zone
管理员操作，仍是测试环境外部配置事项。M1 证据不证明 G8 production 域名/邮件/性能/跨职能发布，也不开放
真实交易、永续、资金出站、外部 Worker 或受限部署。
