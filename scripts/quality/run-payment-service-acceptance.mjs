import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";

if (process.env.ALLOW_PAYMENT_SERVICE_BROWSER_ACCEPTANCE !== "1") {
  throw new Error("set ALLOW_PAYMENT_SERVICE_BROWSER_ACCEPTANCE=1 to run payment browser acceptance");
}

const credentialInput = resolve(process.env.ACCEPTANCE_CREDENTIAL_FILE ?? "");
const evidenceInput = resolve(process.env.ACCEPTANCE_OUTPUT_DIR ?? "");
if (!credentialInput.startsWith("/run/credentials/three-app-credentials-")
  || !/^three-app-credentials-[A-Za-z0-9._-]+\.json$/.test(basename(credentialInput))) {
  throw new Error("ACCEPTANCE_CREDENTIAL_FILE must be a protected three-app credential file");
}
if (!evidenceInput.startsWith("/run/evidence/")) throw new Error("ACCEPTANCE_OUTPUT_DIR must be below /run/evidence/");
const credentialPath = await realpath(credentialInput);
const credentialStat = await stat(credentialPath);
if (!credentialStat.isFile() || (credentialStat.mode & 0o777) !== 0o600) {
  throw new Error("acceptance credential file must be a regular file with mode 0600");
}
await mkdir(evidenceInput, { recursive: true, mode: 0o700 });
await chmod(evidenceInput, 0o700);
const accounts = JSON.parse(await readFile(credentialPath, "utf8"))?.accounts;
if (!accounts) throw new Error("acceptance credential document is invalid");

const edgeOrigin = "https://static.cloudflareinsights.com";
const applications = {
  maintenance: { baseUrl: "https://main-test.agentnovas.com", path: "/integrations?tab=payments" },
  client: { baseUrl: "https://test.agentnovas.com", path: "/account-center?tab=deposit" },
  operations: { baseUrl: "https://ops-test.agentnovas.com", path: "/commercial?tab=deposits" },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login(page, audience, configuration) {
  const account = accounts[audience];
  assert(typeof account?.email === "string" && typeof account?.password === "string", `${audience} credentials missing`);
  await page.goto(`${configuration.baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  assert(await page.locator("form").getAttribute("method") === "post", `${audience} login form is not POST`);
  await page.locator('input[name="identifier"]').fill(account.email);
  await page.locator('input[name="password"]').fill(account.password);
  const response = page.waitForResponse(item => item.url() === `${configuration.baseUrl}/api/auth/login`
    && item.request().method() === "POST");
  await page.locator("form button.rc-primary").click();
  assert((await response).status() === 200, `${audience} login failed`);
  await page.waitForURL(url => url.origin === configuration.baseUrl && !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

async function noOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${label} horizontal overflow: ${JSON.stringify(dimensions)}`);
}

async function noSeriousAxeViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = results.violations.filter(item => item.impact === "critical" || item.impact === "serious");
  assert(violations.length === 0, `${label} accessibility violations: ${JSON.stringify(violations)}`);
}

async function createObservedPage(browser, configuration) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const observations = { externalRequests: [], consoleProblems: [], pageErrors: [], failedResponses: [] };
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol) || url.origin === configuration.baseUrl) return route.continue();
    if (url.origin === edgeOrigin && url.pathname.startsWith("/beacon.min.js/")) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    }
    observations.externalRequests.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  page.on("console", message => {
    if (!["error", "warning"].includes(message.type())) return;
    if (!message.text().includes(edgeOrigin)) observations.consoleProblems.push(message.text());
  });
  page.on("pageerror", error => observations.pageErrors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 400) observations.failedResponses.push({ status: response.status(), url: new URL(response.url()).pathname });
  });
  return { context, page, observations };
}

function assertClean(observations, audience) {
  for (const [name, values] of Object.entries(observations)) {
    assert(values.length === 0, `${audience} ${name}: ${JSON.stringify(values)}`);
  }
}

const browser = await chromium.launch({ headless: true });
const report = { generatedAt: new Date().toISOString(), realAddressCreated: false, realTransferSent: false, applications: {} };
try {
  for (const [audience, configuration] of Object.entries(applications)) {
    process.stdout.write(`PAYMENT_SERVICE_ACCEPTANCE_AUDIENCE=${audience}\n`);
    const { context, page, observations } = await createObservedPage(browser, configuration);
    try {
      await login(page, audience, configuration);
      await page.goto(`${configuration.baseUrl}${configuration.path}`, { waitUntil: "networkidle" });
      await page.locator("main h1").waitFor({ state: "visible" });
      assert(await page.locator("main h1").count() === 1, `${audience} must render exactly one h1`);

      if (audience === "maintenance") {
        const response = await context.request.get(`${configuration.baseUrl}/api/maintenance/payment-providers`);
        assert(response.status() === 200, "Maintenance payment projection failed");
        const payload = await response.json();
        const provider = payload.providers?.find(item => item.provider === "udun");
        assert(provider?.configuredStatus === "disabled" && provider?.effectiveStatus === "disabled", "UDUN is not disabled");
        assert(provider?.hasSecret === false && provider?.providerAuthorized === false, "UDUN secret or outbound state is unsafe");
        assert(provider?.brokerAvailable === true && payload.secretManagement?.browserConfigurable === true, "Payment Broker is unavailable");
        assert(Array.isArray(payload.testHistory), "payment test history is missing");
        assert(!/(?:apiKey|merchantId|gatewayBaseUrl|wrappedKey|ciphertext)/i.test(JSON.stringify(payload)), "payment projection contains secret fields");
        const paymentTabs = page.getByRole("tab");
        assert(await paymentTabs.count() === 3, "payment page tabs are incomplete");
        const tabBoxes = await paymentTabs.evaluateAll(elements => elements.map(element => {
          const bounds = element.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }));
        assert(tabBoxes.every((bounds, index) => bounds.width > 0 && bounds.height > 0
          && Math.abs(bounds.y - tabBoxes[0].y) <= 1
          && (index === 0 || bounds.x > tabBoxes[index - 1].x)), "payment tabs are not a horizontal row");
        await paymentTabs.first().press("ArrowRight");
        assert(await paymentTabs.nth(1).getAttribute("aria-selected") === "true", "payment tabs do not support keyboard navigation");
        await paymentTabs.nth(1).click();
        const secretInputs = page.locator('input[type="password"], input[autocomplete="off"]');
        assert(await secretInputs.count() >= 4, "write-only merchant configuration inputs are missing");
        for (let index = 0; index < await secretInputs.count(); index += 1) {
          assert(await secretInputs.nth(index).inputValue() === "", "merchant configuration was prefilled");
        }
        assert(await page.locator('input[name="mainCoinType"]').inputValue() === "", "mainCoinType was prefilled from an example");
        assert(await page.locator('input[name="tokenCoinType"]').inputValue() === "", "tokenCoinType was prefilled from an example");
        for (const width of [320, 768, 1024, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await noOverflow(page, `maintenance-configuration-${width}`);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await noSeriousAxeViolations(page, "maintenance-configuration");
        await page.screenshot({ path: resolve(evidenceInput, "maintenance-payment-configuration.png"), fullPage: true });
        await paymentTabs.nth(2).click();
        assert(await page.locator("table thead th").count() === 5, "payment test history columns are incomplete");
        const testButtons = page.locator(".rc-action-row button");
        for (let index = 0; index < await testButtons.count(); index += 1) assert(await testButtons.nth(index).isDisabled(), "unconfigured payment test button is enabled");
      } else if (audience === "client") {
        const response = await context.request.get(`${configuration.baseUrl}/api/wallet/deposit-orders`);
        assert(response.status() === 200, "Client deposit projection failed");
        const payload = await response.json();
        assert(payload.options?.currency === "USDT" && payload.options?.networks?.length === 0, "Client exposed an unavailable network");
        assert(payload.options?.availability === "unavailable", "Client availability is not fail-closed");
        assert(await page.locator('section[aria-labelledby="deposit-create-title"]').count() === 0, "Client rendered a deposit form while disabled");
        assert(await page.locator("img, svg").evaluateAll(elements => elements.every(element => !/qr/i.test(`${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("class") ?? ""}`))), "Client rendered a QR code");
      } else {
        const options = await page.locator('main select').last().locator("option").allTextContents();
        for (const status of ["ADDRESS_PROVISIONING", "ADDRESS_UNKNOWN", "ADDRESS_FAILED"]) {
          assert(options.includes(status), `Operations filter is missing ${status}`);
        }
      }

      for (const width of [320, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await noOverflow(page, `${audience}-${width}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await noSeriousAxeViolations(page, audience);
      await page.screenshot({ path: resolve(evidenceInput, `${audience}-payment.png`), fullPage: true });
      const body = await page.locator("body").innerText();
      assert(!/(?:BEGIN [A-Z ]+ PRIVATE KEY|postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|sk-[A-Za-z0-9]{20,})/.test(body), `${audience} rendered secret-like material`);
      assertClean(observations, audience);
      report.applications[audience] = {
        responsiveWidths: [320, 768, 1024, 1440],
        seriousAxeViolations: 0,
        ...(audience === "maintenance" ? { configurationResponsiveWidths: [320, 768, 1024, 1440] } : {}),
      };
      await context.request.post(`${configuration.baseUrl}/api/auth/logout`, {
        headers: { origin: configuration.baseUrl, referer: `${configuration.baseUrl}/` },
      });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const reportPath = resolve(evidenceInput, "payment-service-acceptance-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`PAYMENT_SERVICE_ACCEPTANCE_REPORT=${reportPath}\n`);
