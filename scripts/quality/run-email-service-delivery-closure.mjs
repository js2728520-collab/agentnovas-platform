import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";

if (process.env.ALLOW_REAL_EMAIL_DELIVERY_TEST !== "1") {
  throw new Error("set ALLOW_REAL_EMAIL_DELIVERY_TEST=1 to send one real test email");
}

const baseUrl = "https://main-test.agentnovas.com";
const credentialInput = resolve(process.env.ACCEPTANCE_CREDENTIAL_FILE ?? "");
const evidenceInput = resolve(process.env.ACCEPTANCE_OUTPUT_DIR ?? "");
if (!credentialInput.startsWith("/run/credentials/three-app-credentials-")
  || !/^three-app-credentials-[A-Za-z0-9._-]+\.json$/.test(basename(credentialInput))) {
  throw new Error("ACCEPTANCE_CREDENTIAL_FILE must be a protected /run/credentials/three-app-credentials-*.json file");
}
if (!evidenceInput.startsWith("/run/evidence/")) {
  throw new Error("ACCEPTANCE_OUTPUT_DIR must be below /run/evidence/");
}

const credentialPath = await realpath(credentialInput);
const credentialStat = await stat(credentialPath);
if (!credentialStat.isFile() || (credentialStat.mode & 0o777) !== 0o600) {
  throw new Error("delivery-test credential file must be a regular file with mode 0600");
}
await mkdir(evidenceInput, { recursive: true, mode: 0o700 });
await chmod(evidenceInput, 0o700);

const parsed = JSON.parse(await readFile(credentialPath, "utf8"));
const account = parsed?.accounts?.maintenance;
if (typeof account?.email !== "string" || typeof account?.password !== "string") {
  throw new Error("maintenance delivery-test credentials are missing");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();
const consoleProblems = [];
const edgeInjectedConsoleProblems = [];
const pageErrors = [];
const failedResponses = [];
const externalRequests = [];
let deliveryId = null;
let latestRecord = null;
let terminalRecord = null;
let requestAccepted = false;
let caughtError = null;

await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.searchParams.has("password") || url.searchParams.has("identifier")) {
    return route.abort("blockedbyclient");
  }
  if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === baseUrl) return route.continue();
  if (url.origin === "https://static.cloudflareinsights.com" && url.pathname.startsWith("/beacon.min.js/")) {
    return route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: "" });
  }
  externalRequests.push(safeUrl(url));
  return route.abort("blockedbyclient");
});
page.on("console", message => {
  if (message.type() !== "error" && message.type() !== "warning") return;
  if (message.text().includes("https://static.cloudflareinsights.com") && message.text().includes("integrity")) {
    edgeInjectedConsoleProblems.push(message.text());
    return;
  }
  consoleProblems.push(message.text());
});
page.on("pageerror", error => pageErrors.push(error.message));
page.on("response", response => {
  if (response.status() >= 400) failedResponses.push({ status: response.status(), url: safeUrl(response.url()) });
});

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  assert(await page.locator("form").getAttribute("method") === "post", "login form must use POST");
  await page.locator('input[name="identifier"]').fill(account.email);
  await page.locator('input[name="password"]').fill(account.password);
  const loginResponse = page.waitForResponse(response => response.url() === `${baseUrl}/api/auth/login` && response.request().method() === "POST");
  await page.locator("form button.rc-primary").click();
  const loginResult = await loginResponse;
  assert(loginResult.status() === 200, `maintenance login failed (${loginResult.status()})`);
  await page.waitForURL(url => url.origin === baseUrl && !url.pathname.startsWith("/login"), { timeout: 30_000 });

  await page.goto(`${baseUrl}/integrations?tab=email`, { waitUntil: "domcontentloaded" });
  await page.locator("#email-service-tab-tests").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#email-service-tab-tests").click();
  const panel = page.locator("#email-service-panel-tests");
  await panel.waitFor({ state: "visible" });
  assert(await panel.getByText(account.email, { exact: true }).count() >= 1, "the approved acceptance recipient is not visible");
  const recipientSelect=panel.locator("#email-test-recipient");
  assert(await recipientSelect.count() === 1, "test delivery requires an explicit recipient selector");
  const selectedRecipientId=await recipientSelect.inputValue();
  assert(/^[0-9a-f-]{36}$/i.test(selectedRecipientId), "the selected recipient has no valid durable ID");
  await panel.locator("#email-test-reason").fill("测试站 Resend 真实投递闭环验收");
  const sendButton = panel.locator("button.rc-primary");
  assert(await sendButton.isEnabled(), "real delivery control is not ready");
  await page.screenshot({ path: resolve(evidenceInput, "email-delivery-before-send.png"), fullPage: true });
  await chmod(resolve(evidenceInput, "email-delivery-before-send.png"), 0o600);

  const sendResponse = page.waitForResponse(response => response.url() === `${baseUrl}/api/maintenance/email/test` && response.request().method() === "POST", { timeout: 30_000 });
  await sendButton.click();
  const sendResult = await sendResponse;
  const sendPayload = await sendResult.json().catch(() => ({}));
  const safeCode = typeof sendPayload?.code === "string" ? sendPayload.code : "NO_CODE";
  assert(sendResult.status() === 202, `delivery request failed (${sendResult.status()}, ${safeCode})`);
  assert(sendPayload?.recipient === account.email, "delivery response recipient does not match the explicitly selected address");
  assert(sendPayload?.recipientId === selectedRecipientId, "delivery response recipient ID does not match the explicit selection");
  assert(typeof sendPayload?.deliveryId === "string" && /^[0-9a-f-]{36}$/i.test(sendPayload.deliveryId), "delivery response has no valid delivery ID");
  deliveryId = sendPayload.deliveryId;
  requestAccepted = true;

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await context.request.get(`${baseUrl}/api/maintenance/email/tests?limit=20`);
    assert(response.status() === 200, `delivery history returned ${response.status()}`);
    const payload = await response.json();
    const record = Array.isArray(payload?.tests) ? payload.tests.find(item => item.id === deliveryId) : null;
    if (record) latestRecord = record;
    if (record?.status === "delivered" || record?.status === "failed") {
      terminalRecord = record;
      break;
    }
    await delay(2_000);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#email-service-tab-tests").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#email-service-tab-tests").click();
  if (deliveryId) await page.getByText(deliveryId, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: resolve(evidenceInput, "email-delivery-terminal.png"), fullPage: true });
  await chmod(resolve(evidenceInput, "email-delivery-terminal.png"), 0o600);

  assert(externalRequests.length === 0, `email service made external browser requests: ${JSON.stringify(externalRequests)}`);
  assert(consoleProblems.length === 0, `email service emitted console errors or warnings: ${JSON.stringify(consoleProblems)}`);
  assert(pageErrors.length === 0, `email service emitted page errors: ${JSON.stringify(pageErrors)}`);
  assert(failedResponses.length === 0, `email service returned failed browser responses: ${JSON.stringify(failedResponses)}`);
} catch (error) {
  caughtError = error;
} finally {
  await context.request.post(`${baseUrl}/api/auth/logout`, {
    headers: { origin: baseUrl, referer: `${baseUrl}/` },
  }).catch(() => undefined);
  await context.close();
  await browser.close();
}

const terminalStatus = terminalRecord?.status ?? null;
const latestStatus = latestRecord?.status ?? null;
const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  requestAccepted,
  explicitRecipientMatchedAcceptanceTarget: requestAccepted,
  deliveryId,
  latestStatus,
  terminalStatus,
  sent: latestStatus === "sent" || latestStatus === "delivered",
  delivered: terminalStatus === "delivered",
  failed: terminalStatus === "failed",
  queuedAt: latestRecord?.queuedAt ?? null,
  sentAt: latestRecord?.sentAt ?? null,
  providerEventType: latestRecord?.providerEventType ?? null,
  providerEventAt: latestRecord?.providerEventAt ?? null,
  lastErrorCode: latestRecord?.lastErrorCode ?? null,
  edgeInjectedConsoleProblems: edgeInjectedConsoleProblems.length,
  externalRequests: externalRequests.length,
  consoleProblems: consoleProblems.length,
  pageErrors: pageErrors.length,
  failedResponses: failedResponses.length,
};
const reportPath = resolve(evidenceInput, "email-service-delivery-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`EMAIL_SERVICE_DELIVERY_REPORT=${reportPath}\n`);
process.stdout.write(`EMAIL_SERVICE_DELIVERY_STATUS=${terminalStatus ?? latestStatus ?? "timeout"}\n`);

if (caughtError) throw caughtError;
if (terminalStatus !== "delivered") {
  throw new Error(`real email delivery did not close as delivered (${terminalStatus ?? latestStatus ?? "timeout"})`);
}
