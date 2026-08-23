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
npm run quality:bundle
npm run quality:lighthouse
npm run quality:release
```

The browser run uses one disposable `quality_e2e_*` PostgreSQL schema. It migrates the schema from scratch and creates four primary synthetic identities plus a dedicated Client security identity: Client, Client security, Operations maker, Operations checker, and Maintenance admin. Each wrapper first removes its prior output directory, then recreates it under the repository `outputs/` boundary so a previous run cannot contaminate the current manifest. Before deletion it rejects a symbolic link at the repository root, `outputs/`, any intermediate component, or the target; resolves the existing path into the real repository boundary; and immediately repeats those checks before deleting only the controlled real target. A symlink or realpath escape therefore fails without touching an external target. The wrapper always deletes storage states/passwords/tokens in a `finally` path, even when dropping the schema fails. Cleanup evidence then records the real, redacted failure phase and the command exits unsuccessfully; a failed schema drop can never leave the runtime secret directory behind or produce passing cleanup evidence.

All external-effect switches are forced off, including `PAYMENT_PROVIDER_TESTS_ENABLED`, `PLATFORM_DEMO_VERIFICATION_ENABLED`, and `PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED`. Provider credentials are scrubbed from the child environment, and Playwright requests are aborted unless their URL is loopback or one of the three official app hosts. Playwright maps exact official HTTPS hosts to the matching loopback server while preserving the upstream Host and secure audience Cookie. Lighthouse uses a loopback audit URL so local TLS cannot create false failures, but its runner-owned proxy rewrites the upstream Host to the official Client audience and permits only exact read-only loopback traffic; every other host, method, or tunnel is rejected. Service workers are blocked, and the application server process receives a dead local proxy for all other traffic. No payment, notification, research, runtime, or Demo worker is started.

`MFA_ENFORCEMENT_ENABLED` is also forced to `false` so this evidence matches the current rollout policy. Production enablement uses the separate ADR-0023 MFA-on gate.

## Covered evidence

- strict Host and audience rejection, audience-specific cookie isolation, and production cookie attributes;
- Operations 当前关闭态密码登录直接进入完整会话，且不出现 MFA 绑定挑战；显式开启态由独立单元/PostgreSQL 合同与正式生产专项 Gate 覆盖；
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
- 当前三端初始 JS/CSS gzip：Client 188,677/9,386 bytes，Operations 185,268/8,704 bytes，Maintenance 185,448/8,704 bytes，均通过 200/50 KiB 预算。
- 15 个 Playwright 场景使用五个合成身份与四档 viewport，覆盖三端空浏览器表单登录、Host/Cookie audience 隔离、权限链接、五设备/全量退出、会员 maker-checker、Client/Operations/Maintenance 稳定路由、axe 和 console/network；全部通过。
- 最新三次 Lighthouse performance 均为 0.99，accessibility 与 best practices 均为 1.00；LCP 2,221/2,163/2,162 ms，CLS 均为 0，TBT 24/4.2/3.3 ms，全部满足 Gate 预算。登录由 audience Server Component 在导入已认证应用树之前分发，不启动 session 数据树或受保护根路由预取，并关闭登录页未使用字体的 preload。
- 本机恢复演练已在 2026-08-23 由专用 `agentnovas_migrator` 对 fresh 源库覆盖 63 个迁移和 146 张表；迁移 registry checksum、表集合与逐表行数在恢复前后完全一致，一次性源库、目标库和临时 dump 均已清理，临时 `CREATEDB` 已撤销。`pg_dump --enable-row-security` 在不授予 `BYPASSRLS` 的前提下完整验证 `0043` 的 FORCE RLS。本轮新增范围为 `0044`–`0062`，其中 `0050`–`0053` 是执行对账、熔断、实盘路由与实盘现货部署，`0060`–`0062` 是组合账本的 book 维度、对账手续费与实盘落账；实盘仍由 `isLiveExecutionReady()` 关闭，演练未执行任何真实商户请求或资金操作。该证据只对截至 `0062` 的当前迁移集合有效；新增、改名或 checksum 变化会自动使恢复 Gate 失效，必须重跑演练，不能手工递增文档数字。
- 本 runner 验证角色模板、Client Web/Auth 攻击矩阵和隔离测试，但不替代目标环境的进程角色 smoke。每次部署仍须从 Client 两条连接及 Operations、Maintenance、各 Worker、payment webhook、migrator 的实际 secret/env 执行 `SELECT current_user` 并保存脱敏结果；不得记录连接串或口令。
- 真实 Email、Demo、Payment、交易或 DNS/TLS smoke 不属于本 runner。没有凭证时产品以 `not_configured/configured_not_sent/disabled` 安全降级；若决定启用，必须在独立 staging 记录中补充真实 provider 证据。

## Temporary development-tool vulnerability exception

当前 lockfile 报告生产依赖 high/critical 为 0；完整开发工具链仍有 17 项（3 low、5 moderate、9 high、0 critical）。这是临时发布工程例外，不是生产风险豁免。

- Owner: Platform Release Engineering.
- Controls: trusted lockfile only; no untrusted fixture/source input; isolated CI runner; no provider secrets; loopback PostgreSQL; infrastructure egress deny; evidence retained for no more than 14 days.
- Deadline: 2026-08-28 and in all cases before the first paid Beta invitation is opened.
- Exit evidence: upgrade or override the affected development chains, rerun full `npm audit`, browser, Lighthouse, type, lint, and release evidence gates, and record production high/critical at zero. If the deadline is missed, Gate 6 remains failed.
