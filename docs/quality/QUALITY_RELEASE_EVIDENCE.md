# Controlled Beta quality evidence runner

This runner creates repeatable release evidence without contacting a payment provider, an email provider, a Demo exchange, or any other external host. It resolves only approved direct test dependencies and never downloads tools at runtime.

## Required package and script integration

The package owner must add these direct, pinned development dependencies and refresh the lockfile:

- `@playwright/test@1.62.1`
- `@axe-core/playwright@4.13.0`
- `@lhci/cli@0.15.1`

The package owner must add these scripts without changing the commands:

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

The browser run uses one disposable `quality_e2e_*` PostgreSQL schema. It migrates the schema from scratch and creates four synthetic identities: Client, Operations maker, Operations checker, and Maintenance admin. Each wrapper first removes its prior output directory, then recreates it under the repository `outputs/` boundary so a previous run cannot contaminate the current manifest. Before deletion it rejects a symbolic link at the repository root, `outputs/`, any intermediate component, or the target; resolves the existing path into the real repository boundary; and immediately repeats those checks before deleting only the controlled real target. A symlink or realpath escape therefore fails without touching an external target. The wrapper always deletes storage states/passwords/tokens in a `finally` path, even when dropping the schema fails. Cleanup evidence then records the real, redacted failure phase and the command exits unsuccessfully; a failed schema drop can never leave the runtime secret directory behind or produce passing cleanup evidence.

All external-effect switches are forced off, including `PAYMENT_PROVIDER_TESTS_ENABLED`, `PLATFORM_DEMO_VERIFICATION_ENABLED`, and `PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED`. Provider credentials are scrubbed from the child environment, and Playwright requests are aborted unless their URL is loopback or one of the three official app hosts. Playwright maps exact official HTTPS hosts to the matching loopback server while preserving the upstream Host and secure audience Cookie. Lighthouse uses a loopback audit URL so local TLS cannot create false failures, but its runner-owned proxy rewrites the upstream Host to the official Client audience and permits only exact read-only loopback traffic; every other host, method, or tunnel is rejected. Service workers are blocked, and the application server process receives a dead local proxy for all other traffic. No payment, notification, research, runtime, or Demo worker is started.

## Covered evidence

- strict Host and audience rejection, audience-specific cookie isolation, and production cookie attributes;
- Operations 首次密码登录、TOTP 设置密钥、六位码确认、8 枚一次性恢复码和完整会话跳转；
- the synthetic Client order → maker evidence/submit → maker denial → checker approval/replay path;
- legal-document acceptance, one membership activation, 1,000 credits, and exactly three isolated 10,000 USDT paper portfolios;
- Operations PII masking and recursive public-payload checks for raw credential fields;
- four identity-specific application pages at 320, 768, 1024, and 1440 pixels;
- serious/critical axe violations, keyboard entry, horizontal overflow, browser console/page errors, failed local requests, and denied external requests;
- three application initial JS/CSS gzip budgets from Next build manifests;
- three-run Client login Lighthouse thresholds for LCP, CLS, TBT, accessibility, best practices, and resource size;
- a final hash manifest that accepts only an unfiltered eight-test E2E run, three passing bundle reports, three distinct existing Lighthouse JSON reports independently revalidated for scores, timings and non-empty script/stylesheet/image evidence, and complete cleanup evidence.

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

## Known release blockers outside this change

- The pinned quality dependencies and five package commands are integrated. The separate CI `quality-release` job and infrastructure-level egress deny remain release-engineering actions.
- Full invitation delivery, recovery-code consumption/revocation, all seven strategy lifecycle stages, expiry/weekly-fee paths, Demo fixture receipts, Shift+Tab/Escape/focus-return dialog behavior, and rollback/restore drills remain required by the broader Gate 6/7 checklist. This harness does not claim those gates are complete.
- A real provider, email, payment, or Demo smoke is never part of this runner. Any separately authorized staging smoke needs a different job and approval record.
- Integrated evidence after the MFA and hard-404 acceptance closeout: Client 185,320/8,012 bytes, Operations 202,099/8,012 bytes, and Maintenance 196,004/8,012 bytes for initial JS/CSS gzip. The eight canonical Playwright scenarios passed with four viewports, first-time Operations TOTP enrollment, and zero serious/critical axe findings. Three Lighthouse runs scored performance 0.99/0.98/0.99, accessibility 1.00, best practices 1.00, LCP 1,960/2,323/1,968 ms, CLS 0, and TBT 5/7/5 ms. These are local controlled-Beta artifacts and must be regenerated on the final release commit or any later code change.

## Temporary development-tool vulnerability exception

The package integration at `8e49aee` reports zero high/critical production dependency findings, but 17 development-tool findings, including 9 high findings. This is a temporary release-engineering exception, not a production-risk waiver.

- Owner: Platform Release Engineering.
- Controls: trusted lockfile only; no untrusted fixture/source input; isolated CI runner; no provider secrets; loopback PostgreSQL; infrastructure egress deny; evidence retained for no more than 14 days.
- Deadline: 2026-08-28 and in all cases before the first paid Beta invitation is opened.
- Exit evidence: upgrade or override the affected development chains, rerun full `npm audit`, browser, Lighthouse, type, lint, and release evidence gates, and record production high/critical at zero. If the deadline is missed, Gate 6 remains failed.
