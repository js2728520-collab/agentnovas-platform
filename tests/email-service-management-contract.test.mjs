import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("independent recipients store encrypted addresses, verification state and remain least-privileged", async () => {
  const migration = await read("postgres/migrations/0091_email_service_management_v2.sql");
  const grants = await read("deploy/postgres/least-privilege-roles.sql");
  assert.match(migration, /recipient_ciphertext/i);
  assert.match(migration, /pending_verification/i);
  assert.match(migration, /verification_code_hash/i);
  assert.match(migration, /test_recipient_id/i);
  assert.doesNotMatch(migration, /recipient_email|email_address/i);
  assert.match(grants, /notification_email_test_recipients[\s\S]+agentnovas_maint_web/i);
  assert.match(grants, /GRANT SELECT ON[\s\S]+notification_email_test_recipients[\s\S]+agentnovas_notification_worker/i);
  assert.doesNotMatch(grants, /GRANT (?:INSERT|UPDATE|DELETE)[^;]*notification_email_test_recipients[^;]*agentnovas_notification_worker/i);
});

test("email test API exposes its explicit recipient and refuses an unauthorized target before enqueue", async () => {
  const route = await read("app/api/maintenance/email/test/route.maintenance.ts");
  const service = await read("lib/email-test-recipient-management.ts");
  assert.match(route, /recipientId/);
  assert.match(route, /loadActiveEmailTestRecipient/);
  assert.match(service, /TEST_RECIPIENT_NOT_AUTHORIZED/);
  assert.match(route, /test_recipient_id/);
  assert.match(route, /deliveryId/);
});

test("recipient lifecycle has dedicated routes and never returns verification plaintext", async () => {
  const collection = await read("app/api/maintenance/email/recipients/route.maintenance.ts");
  const item = await read("app/api/maintenance/email/recipients/[id]/route.maintenance.ts");
  const verification = await read("app/api/maintenance/email/recipients/[id]/verification/route.maintenance.ts");
  assert.match(collection, /normalizeEmailRecipientCreateCommand/);
  assert.match(collection, /createEmailTestRecipient/);
  assert.match(item, /updateEmailTestRecipient/);
  assert.match(item, /deleteEmailTestRecipient/);
  assert.match(verification, /verifyEmailTestRecipient/);
  assert.match(verification, /resendEmailTestRecipientVerification/);
  assert.doesNotMatch(collection + item + verification, /verificationCode\s*:/);
});

test("write-only secret control stores ciphertext requests for a separate broker", async () => {
  const migration = await read("postgres/migrations/0091_email_service_management_v2.sql");
  const route = await read("app/api/maintenance/email/secrets/route.maintenance.ts");
  const service = await read("lib/email-secret-management.ts");
  assert.match(migration, /notification_email_secret_requests/i);
  assert.match(migration, /envelope_json jsonb/i);
  assert.match(route, /normalizeEmailSecretRequestCommand/);
  assert.match(route, /createEmailSecretRequest/);
  assert.doesNotMatch(route, /RESEND_API_KEY|RESEND_WEBHOOK_SECRET/);
  assert.doesNotMatch(route, /privateKey/);
  assert.match(service, /readFile\(\/\* turbopackIgnore: true \*\/ path/);
});

test("email configuration and history have dedicated permissioned API adapters", async () => {
  const configuration = await read("app/api/maintenance/email/configuration/route.maintenance.ts");
  const history = await read("app/api/maintenance/email/tests/route.maintenance.ts");
  for (const source of [configuration, history]) assert.match(source, /maint\.email_integrations\.manage/);
  assert.match(configuration, /normalizeEmailConfigurationCommand/);
  assert.match(configuration, /runMaintenanceIdempotentCommand/);
  assert.match(configuration, /maintenance\.email_configuration\.update/);
  assert.match(configuration, /idempotency-replayed/);
  assert.match(history, /listEmailTestHistory/);
  assert.doesNotMatch(configuration + history, /RESEND_API_KEY|apiKey\s*:/);
  assert.doesNotMatch(configuration + history, /webhookSecret\s*:/);
});

test("email configuration migration extends the durable Maintenance idempotency contract", async () => {
  const migration = await read("postgres/migrations/0090_email_service_management.sql");
  const idempotency = await read("lib/maintenance-idempotency.ts");
  assert.match(migration, /maintenance\.email_configuration\.update/);
  assert.match(idempotency, /maintenance\.email_configuration\.update/);
});

test("reusable email manager is API-agnostic and the Maintenance workspace is only its adapter", async () => {
  const component = await read("packages/ui/src/email-service-manager/email-service-manager.tsx");
  const configuration = await read("packages/ui/src/email-service-manager/email-service-configuration.tsx");
  const types = await read("packages/ui/src/email-service-manager/types.ts");
  const workspace = await read("apps/maintenance/ui/email-integration-workspace.tsx");
  assert.doesNotMatch(component, /fetch\(|\/api\/maintenance/);
  assert.match(types, /onConfigurationChange/);
  assert.match(types, /onSendTest/);
  assert.match(types, /onSecretChange/);
  assert.match(types, /onRecipientVerify/);
  assert.match(component, /role="tabpanel"/);
  assert.match(component, /ArrowRight/);
  assert.match(component, /aria-controls/);
  assert.match(configuration, /rc-email-provider-facts/);
  assert.match(workspace, /EmailServiceManager/);
  assert.match(workspace, /\/api\/maintenance\/email\/tests/);
  assert.match(workspace, /recipient/);
});

test("email status and delivery feedback are localized without allowing badges to wrap", async () => {
  const presentation = await read("packages/ui/src/email-service-manager/presentation.ts");
  const pageState = await read("packages/ui/src/page-state.tsx");
  const tests = await read("packages/ui/src/email-service-manager/email-service-tests.tsx");
  const css = await read("app/riverton-console.css");
  assert.match(presentation, /failed:\s*"失败"/);
  assert.match(presentation, /recipient_not_authorized:\s*"测试收件地址未授权，请先在配置中授权。"/);
  assert.match(pageState, /label\?: string/);
  assert.match(pageState, /t\(label \?\? value \?\? "未知"\)/);
  assert.match(tests, /emailDeliveryErrorMessage/);
  assert.match(css, /\.rc-status\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.rc-status\s*\{[^}]*flex-shrink:\s*0/s);
});

test("real email delivery closure is a separate explicitly gated test-site workflow", async () => {
  const source = await read("scripts/quality/run-email-service-delivery-closure.mjs");
  assert.match(source, /ALLOW_REAL_EMAIL_DELIVERY_TEST/);
  assert.match(source, /https:\/\/main-test\.agentnovas\.com/);
  assert.match(source, /three-app-credentials-/);
  assert.match(source, /credentialStat\.mode & 0o777/);
  assert.match(source, /\/run\/evidence\//);
  assert.match(source, /email-service-delivery-report\.json/);
  assert.match(source, /requestAccepted\s*=\s*true/);
  assert.match(source, /latestRecord\s*=\s*record/);
  assert.match(source, /latestStatus/);
  assert.match(source, /chmod\(resolve\(evidenceInput, "email-delivery-before-send\.png"\), 0o600\)/);
  assert.match(source, /chmod\(resolve\(evidenceInput, "email-delivery-terminal\.png"\), 0o600\)/);
  assert.doesNotMatch(source, /realEmailSent/);
  assert.match(source, /terminalStatus === "delivered"/);
  assert.match(source, /terminalStatus === "failed"/);
  assert.doesNotMatch(source, /process\.stdout\.write\([^\n]*(?:account\.email|payload\.recipient)/);
});

test("real delivery uses a temporary least-privilege account with deterministic teardown", async () => {
  const source = await read("scripts/quality/manage-email-delivery-acceptance-account.mjs");
  assert.match(source, /ALLOW_EMAIL_DELIVERY_ACCOUNT_PROVISIONING/);
  assert.match(source, /EMAIL_DELIVERY_TEST_SITE_HOST/);
  assert.match(source, /main-test\.agentnovas\.com/);
  assert.match(source, /\/run\/config\/resend-test\.answers/);
  assert.match(source, /maint\.email_integrations\.manage/);
  assert.match(source, /notification_email_test_recipients/);
  assert.match(source, /encryptEmailTestRecipient/);
  assert.match(source, /recipientCiphertext/);
  assert.match(source, /UPDATE users[\s\S]+status='disabled'/);
  assert.match(source, /UPDATE user_role_assignments[\s\S]+status='revoked'/);
  assert.match(source, /UPDATE roles[\s\S]+status='disabled'/);
  assert.match(source, /UPDATE sessions[\s\S]+revoked_at=/);
  assert.match(source, /UPDATE notification_email_test_recipients[\s\S]+status='deleted'/);
  assert.match(source, /maintenance\.email_delivery_acceptance\.provision/);
  assert.match(source, /maintenance\.email_delivery_acceptance\.teardown/);
  assert.match(source, /active_assignment/);
  assert.match(source, /active_session/);
  assert.match(source, /expires_at::timestamptz>now\(\)/);
  assert.match(source, /reusedIdentity/);
  assert.match(source, /\^legacy-\[a-f0-9\]\{32\}\$/);
  assert.match(source, /mode:\s*0o600/);
  assert.doesNotMatch(source, /SELECT[\s\S]{0,180}permission\.key[\s\S]{0,180}permission\.status\s*=\s*'active'/);
  assert.doesNotMatch(source, /process\.stdout\.write\([^\n]*(?:targetEmail|password)/);
});

test("worker database test authorization is limited to the maintenance test template", async () => {
  const worker = await read("lib/notification-email-worker.ts");
  assert.match(worker, /notificationDatabaseTestRecipientAllowed/);
  assert.match(worker, /templateKey === "maintenance_email_test"/);
  assert.match(worker, /notificationRecipientAllowed/);
});
