import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Operations navigation exposes only contracted commercial Beta workspaces", async () => {
  const app = await read("apps/operations/ui/operations-app.tsx");
  assert.match(app, /href: "\/membership-orders"[\s\S]*ops\.membership_orders\.view/);
  assert.match(app, /href: "\/performance-statements"[\s\S]*ops\.performance_fees\.view/);
  assert.match(app, /MembershipOrdersWorkspace/);
  assert.match(app, /PerformanceStatementsWorkspace/);
  assert.match(app, /href: "\/credits"[\s\S]*ops\.credits\.view/);
  assert.match(app, /CreditsWorkspace/);
  assert.doesNotMatch(app, /策略市场|自动结算|经营分析/);
});

test("membership order workspace implements scoped URL queues and maker-checker actions", async () => {
  const source = await read("apps/operations/ui/membership-orders-workspace.tsx");
  for (const endpoint of [
    "/api/operations/membership-orders",
    "/evidence",
    "/submit",
    "/decision",
  ]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.match(source, /URLSearchParams/);
  assert.match(source, /nextCursor/);
  assert.match(source, /idempotency-key/);
  assert.match(source, /paymentEvidenceId/);
  assert.match(source, /ConfirmActionDialog/);
  assert.match(source, /recordedByUserId !== viewerUserId/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /await refresh/);
  assert.match(source, /commercialMutation/);
  assert.doesNotMatch(source, /自动收款成功|资金已自动执行/);
});

test("performance fee workspace separates generation, assessment, evidence and payment review", async () => {
  const source = await read("apps/operations/ui/performance-statements-workspace.tsx");
  for (const endpoint of [
    "/api/operations/performance-statements",
    "/generate",
    "/decision",
    "/payment-evidence",
    "/payment-decision",
  ]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.match(source, /上一完整 UTC 周/);
  assert.match(source, /paper 模拟净收益/);
  assert.match(source, /idempotency-key/);
  assert.match(source, /paymentEvidenceId/);
  assert.match(source, /ConfirmActionDialog/);
  assert.match(source, /await refresh/);
  assert.match(source, /commercialMutation/);
  assert.doesNotMatch(source, /真实投资收益|自动扣款成功|自动结算成功/);
});

test("commercial detail APIs expose allowlisted checker actions across sessions", async () => {
  const membership = await read("app/api/operations/membership-orders/[id]/route.ts");
  assert.match(membership, /canReview/);
  assert.match(membership, /submitted_by_user_id/);
  assert.match(membership, /recorded_by_user_id/);

  const performance = await read("app/api/operations/performance-statements/[id]/route.ts");
  assert.match(performance, /ops\.performance_fees\.view/);
  assert.match(performance, /assertOperationsStatementScope/);
  assert.match(performance, /generated_by_user_id/);
  assert.match(performance, /paymentEvidenceDto/);
  assert.match(performance, /canReviewAssessment|canReviewPayment/);
  assert.doesNotMatch(performance, /reference_fingerprint\s*,|strategy_codes_json/);
});

test("Operations credits view is scoped and read-only", async () => {
  const route = await read("app/api/operations/credits/route.ts");
  assert.match(route, /ops\.credits\.view/);
  assert.match(route, /commercialCustomerScopePredicate/);
  assert.match(route, /organizationIds/);
  assert.match(route, /u\.role='customer'/);
  assert.match(route, /cache-control/);
  assert.doesNotMatch(route, /INSERT|UPDATE|DELETE|mutateAiCredits/);

  const workspace = await read("apps/operations/ui/credits-workspace.tsx");
  assert.match(workspace, /\/api\/operations\/credits/);
  assert.match(workspace, /URLSearchParams/);
  assert.match(workspace, /nextCursor/);
  assert.match(workspace, /只读/);
  assert.doesNotMatch(workspace, /调整积分|批准调整|ops\.credits\.adjust/);
});

test("commercial mutations return expired sessions to the current target", async () => {
  const helper = await read("apps/operations/ui/commercial-mutation.ts");
  assert.match(helper, /response\.status === 401/);
  assert.match(helper, /window\.location\.pathname/);
  assert.match(helper, /\/login\?next=/);
  assert.match(helper, /apiErrorMessage/);
});

test("organization activation UI only reports queued set-password delivery", async () => {
  const source = await read("app/organization-relationship-tree.tsx");
  assert.doesNotMatch(source, /temporaryPassword|临时密码|复制全部登录信息/);
  assert.match(source, /deliveryStatus/);
  assert.match(source, /设置密码/);
  assert.match(source, /邮件队列/);
});

test("Maintenance Demo safe view never selects credential ciphertext", async () => {
  const route = await read("app/api/maintenance/demo-exchanges/route.ts");
  assert.match(route, /maint\.demo_exchanges\.view/);
  assert.match(route, /platform_demo_accounts_safe/);
  assert.match(route, /cache-control/);
  assert.doesNotMatch(route, /api_key_ciphertext|secret_ciphertext|passphrase_ciphertext/);

  const workspace = await read("apps/maintenance/ui/demo-exchanges-workspace.tsx");
  assert.match(workspace, /\/api\/maintenance\/demo-exchanges/);
  assert.match(workspace, /平台测试账户，不代表客户真实成交/);
  assert.match(workspace, /hasApiKey|hasSecret/);
  assert.match(workspace, /lastVerifiedAt|latestReceipt|dailyNotional/);
  assert.doesNotMatch(workspace, /apiKey|ciphertext|privateEndpoint|webhookPayload/);
});

test("Maintenance distinguishes Worker gates and keeps Payment disabled", async () => {
  const health = await read("apps/maintenance/ui/system-health-workspace.tsx");
  for (const state of [
    "configured",
    "enabled",
    "externalWritesEnabled",
    "liveness",
    "health",
    "heartbeatAt",
  ]) assert.match(health, new RegExp(state));

  const payment = await read("apps/maintenance/ui/payment-integration-workspace.tsx");
  assert.match(payment, /Beta.*disabled|始终禁用/s);
  assert.doesNotMatch(payment, /切换 active|切换 sandbox/);
  assert.doesNotMatch(payment, /kind: "status"/);
});
