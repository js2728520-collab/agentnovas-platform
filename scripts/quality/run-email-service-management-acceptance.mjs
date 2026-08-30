import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";

if (process.env.ALLOW_EMAIL_SERVICE_ACCEPTANCE !== "1") {
  throw new Error("set ALLOW_EMAIL_SERVICE_ACCEPTANCE=1 to run email-service acceptance");
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
  throw new Error("acceptance credential file must be a regular file with mode 0600");
}
await mkdir(evidenceInput, { recursive: true, mode: 0o700 });
await chmod(evidenceInput, 0o700);

const parsed = JSON.parse(await readFile(credentialPath, "utf8"));
const account = parsed?.accounts?.maintenance;
if (typeof account?.email !== "string" || typeof account?.password !== "string") {
  throw new Error("maintenance acceptance credentials are missing");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

async function noHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${label} has horizontal overflow: ${JSON.stringify(dimensions)}`);
}

async function loadStatus(context) {
  const response = await context.request.get(`${baseUrl}/api/maintenance/email/status`);
  assert(response.status() === 200, `email status returned ${response.status()}`);
  return response.json();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();
const consoleProblems = [];
const edgeInjectedConsoleProblems = [];
const pageErrors = [];
const failedResponses = [];
const externalRequests = [];
const widths = [320, 768, 1024, 1440];
const configurationWidths = [320, 1440];
let logoutCompleted = false;

await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.searchParams.has("password") || url.searchParams.has("identifier")) {
    throw new Error("credential-like login data was placed in a URL");
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
  assert(await page.locator("form").getAttribute("method") === "post", "login form must fail closed before hydration");
  await page.locator('input[name="identifier"]').fill(account.email);
  await page.locator('input[name="password"]').fill(account.password);
  const loginResponse = page.waitForResponse(response => response.url() === `${baseUrl}/api/auth/login` && response.request().method() === "POST");
  await page.locator("form button.rc-primary").click();
  const loginResult = await loginResponse;
  if (loginResult.status() !== 200) {
    const payload = await loginResult.json().catch(() => ({}));
    const safeCode = typeof payload?.code === "string" ? payload.code : "NO_CODE";
    throw new Error(`maintenance login failed (${loginResult.status()}, ${safeCode})`);
  }
  await page.waitForURL(url => url.origin === baseUrl && !url.pathname.startsWith("/login"), { timeout: 30_000 });

  await page.goto(`${baseUrl}/integrations?tab=email`, { waitUntil: "domcontentloaded" });
  await page.locator("main h1").waitFor({ state: "visible", timeout: 30_000 });
  assert(await page.locator("main h1").count() === 1, "email service page must render exactly one h1");

  const tabs = page.locator('[role="tab"][aria-controls^="email-service-panel-"]');
  await page.locator("#email-service-tab-overview").waitFor({ state: "visible", timeout: 30_000 }).catch(async () => {
    const heading = (await page.locator("main h1").textContent())?.trim() || "NO_HEADING";
    const path = new URL(page.url()).pathname;
    throw new Error(`email service manager did not load (${path}, ${heading})`);
  });
  assert(await tabs.count() === 3, "email service manager must expose overview, configuration, and tests tabs");
  assert(await tabs.nth(0).getAttribute("aria-selected") === "true", "overview must be the default tab");
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  assert(await tabs.nth(1).getAttribute("aria-selected") === "true", "ArrowRight did not select the configuration tab");
  assert(await tabs.nth(1).evaluate(element => element === document.activeElement), "configuration tab did not receive keyboard focus");

  const configurationPanel = page.locator('#email-service-panel-configuration');
  await configurationPanel.waitFor({ state: "visible" });
  const recipientsResponse = await context.request.get(`${baseUrl}/api/maintenance/email/recipients`);
  assert(recipientsResponse.status() === 200, `email recipients returned ${recipientsResponse.status()}`);
  const recipientPayload = await recipientsResponse.json();
  const activeRecipient = Array.isArray(recipientPayload?.recipients)
    ? recipientPayload.recipients.find(item => item.address === account.email && item.status === "active")
    : null;
  assert(activeRecipient, "the independently selected acceptance recipient is not active");
  assert(await configurationPanel.getByText(account.email, { exact: true }).count() >= 1, "configuration does not show the independently managed recipient");
  const secretInputs = configurationPanel.locator('input[type="password"]');
  assert(await secretInputs.count() === 2, "configuration must expose write-only API Key and Webhook Secret controls");
  assert(await secretInputs.nth(0).inputValue() === "" && await secretInputs.nth(1).inputValue() === "", "write-only secret controls must never be prefilled");

  const status = await loadStatus(context);
  assert(typeof status?.apiKeyPresent === "boolean" && typeof status?.webhookSecretPresent === "boolean", "secret custody projection is incomplete");
  assert(status?.secretManagement?.browserConfigurable === true, "write-only Secret Broker is not ready");
  assert(
    status?.webhookUrl === `${baseUrl}/api/integrations/resend/webhook`,
    "Webhook URL is not the canonical Maintenance test endpoint",
  );

  for (const width of configurationWidths) {
    await page.setViewportSize({ width, height: 1000 });
    await noHorizontalOverflow(page, `email service configuration at ${width}px`);
    await page.screenshot({ path: resolve(evidenceInput, `email-service-configuration-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  await tabs.nth(1).focus();
  await page.keyboard.press("End");
  assert(await tabs.nth(2).getAttribute("aria-selected") === "true", "End did not select the tests tab");
  const testsPanel = page.locator('#email-service-panel-tests');
  await testsPanel.waitFor({ state: "visible" });
  assert(await testsPanel.getByText(account.email, { exact: true }).count() >= 1, "tests tab does not show the exact selected recipient");
  assert(await testsPanel.locator("#email-test-recipient").inputValue() === activeRecipient.id, "tests tab did not explicitly select the verified recipient");

  const historyResponse = await context.request.get(`${baseUrl}/api/maintenance/email/tests?limit=20`);
  assert(historyResponse.status() === 200, `email test history returned ${historyResponse.status()}`);
  const history = await historyResponse.json();
  assert(Array.isArray(history?.tests), "email test history is not a list");
  const statuses = history.tests.reduce((counts, item) => {
    const key = typeof item.status === "string" ? item.status : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const historyErrorCodes = [...new Set(history.tests
    .map(item => item.lastErrorCode)
    .filter(value => typeof value === "string" && /^[A-Z0-9_:-]{1,80}$/.test(value)))];
  assert(history.tests.every(item => typeof item.recipient === "string" && item.recipient.length > 0), "history contains a record without a visible recipient");
  assert(await testsPanel.locator(".rc-card-list article").count() === history.tests.length, "rendered history does not match API history");

  await testsPanel.locator("#email-test-reason").fill("确认测试按钮目标与反馈，不发送邮件");
  const sendButton = testsPanel.locator("button.rc-primary");
  assert(await sendButton.isEnabled(), "test send control is not ready after selecting a verified recipient");
  assert(await sendButton.textContent() !== null, "test send control has no visible label");
  const refreshResponses = Promise.all([
    page.waitForResponse(response => response.url() === `${baseUrl}/api/maintenance/email/status` && response.status() === 200),
    page.waitForResponse(response => response.url().startsWith(`${baseUrl}/api/maintenance/email/tests`) && response.status() === 200),
    page.waitForResponse(response => response.url() === `${baseUrl}/api/maintenance/email/recipients` && response.status() === 200),
  ]);
  await testsPanel.locator("button.rc-button").click();
  await refreshResponses;

  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await noHorizontalOverflow(page, `email service tests at ${width}px`);
    await page.screenshot({ path: resolve(evidenceInput, `email-service-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const seriousViolations = accessibility.violations.filter(item => item.impact === "critical" || item.impact === "serious");
  assert(seriousViolations.length === 0, `email service has serious accessibility violations: ${JSON.stringify(seriousViolations)}`);

  const bodyText = await page.locator("body").innerText();
  assert(!/(?:BEGIN [A-Z ]+ PRIVATE KEY|postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|re_[A-Za-z0-9_-]{20,})/.test(bodyText), "email service rendered secret-like material");
  assert(externalRequests.length === 0, `email service made external browser requests: ${JSON.stringify(externalRequests)}`);
  assert(consoleProblems.length === 0, `email service emitted console errors or warnings: ${JSON.stringify(consoleProblems)}`);
  assert(pageErrors.length === 0, `email service emitted page errors: ${JSON.stringify(pageErrors)}`);
  assert(failedResponses.length === 0, `email service returned failed browser responses: ${JSON.stringify(failedResponses)}`);

  const logoutResponse = await context.request.post(`${baseUrl}/api/auth/logout`, {
    headers: { origin: baseUrl, referer: `${baseUrl}/` },
  });
  assert(logoutResponse.ok(), "maintenance logout failed");
  logoutCompleted = true;

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    tabs: 3,
    independentRecipientSelected: true,
    selectedRecipientStatus: activeRecipient.status,
    selectedRecipientSuppressed: activeRecipient.suppressed === true,
    effectiveStatus: status.effectiveStatus,
    providerAuthorized: status.providerAuthorized === true,
    apiKeyPresent: status.apiKeyPresent === true,
    webhookSecretPresent: status.webhookSecretPresent === true,
    writeOnlySecretFieldsAvailable: true,
    providerSecretsPrefilled: false,
    secretBrokerAvailable: status.secretManagement.broker.available === true,
    webhookUrlVisible: true,
    historyRecordCount: history.tests.length,
    historyStatusCounts: statuses,
    historyErrorCodes,
    sendButtonReady: true,
    realEmailSent: false,
    configurationResponsiveWidths: configurationWidths,
    responsiveWidths: widths,
    seriousAccessibilityViolations: seriousViolations.length,
    edgeInjectedConsoleProblems: edgeInjectedConsoleProblems.length,
    externalRequests: externalRequests.length,
    consoleProblems: consoleProblems.length,
    pageErrors: pageErrors.length,
    failedResponses: failedResponses.length,
  };
  const reportPath = resolve(evidenceInput, "email-service-acceptance-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`EMAIL_SERVICE_ACCEPTANCE_REPORT=${reportPath}\n`);
} finally {
  if (!logoutCompleted) {
    await context.request.post(`${baseUrl}/api/auth/logout`, {
      headers: { origin: baseUrl, referer: `${baseUrl}/` },
    }).catch(() => undefined);
  }
  await context.close();
  await browser.close();
}
