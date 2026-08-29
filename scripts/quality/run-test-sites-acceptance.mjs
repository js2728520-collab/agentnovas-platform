import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";

const enabled = process.env.ALLOW_TEST_SITE_BROWSER_ACCEPTANCE === "1";
if (!enabled) throw new Error("set ALLOW_TEST_SITE_BROWSER_ACCEPTANCE=1 to run test-site browser acceptance");

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
const accounts = parsed?.accounts;
if (!accounts || typeof accounts !== "object") throw new Error("acceptance credential document is invalid");

const applications = {
  client: {
    baseUrl: "https://test.agentnovas.com",
    homePath: "/dashboard",
    localeOptionCount: 7,
    defaultLocale: "en-US",
    navigationHrefs: ["/dashboard", "/trading", "/strategies", "/market", "/assistant"],
    crossAudienceUrl: "https://ops-test.agentnovas.com/api/auth/me",
  },
  operations: {
    baseUrl: "https://ops-test.agentnovas.com",
    homePath: "/",
    localeOptionCount: 2,
    defaultLocale: "zh-CN",
    navigationHrefs: ["/", "/customers", "/trading-operations", "/commercial", "/governance"],
    crossAudienceUrl: "https://main-test.agentnovas.com/api/auth/me",
  },
  maintenance: {
    baseUrl: "https://main-test.agentnovas.com",
    homePath: "/",
    localeOptionCount: 2,
    defaultLocale: "zh-CN",
    navigationHrefs: ["/", "/ai-strategy", "/integrations", "/configurations", "/releases"],
    crossAudienceUrl: "https://test.agentnovas.com/api/auth/me",
  },
};

const themeModes = ["light", "dark"];
const themePalettes = ["classic", "harbor", "forest"];
const widths = [320, 768, 1024, 1440];
const edgeInjectedScript = {
  origin: "https://static.cloudflareinsights.com",
  pathPrefix: "/beacon.min.js/",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

async function expectNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(overflow.scrollWidth <= overflow.clientWidth + 1, `${label} has horizontal overflow: ${JSON.stringify(overflow)}`);
}

async function expectCriticalAccessibility(page, label) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const severe = result.violations.filter((item) => item.impact === "critical" || item.impact === "serious");
  assert(severe.length === 0, `${label} has serious accessibility violations: ${JSON.stringify(severe)}`);
}

async function expectHorizontalHubTabs(page, label) {
  const tabLayout = await page.locator(".rc-hub-tabs").evaluate((element) => {
    const tabTops = [...element.querySelectorAll("a")].map((tab) => Math.round(tab.getBoundingClientRect().top));
    return {
      display: getComputedStyle(element).display,
      tabCount: tabTops.length,
      topDelta: tabTops.length > 0 ? Math.max(...tabTops) - Math.min(...tabTops) : null,
    };
  });
  assert(tabLayout.display === "flex", `${label} hub tabs must use a horizontal flex layout: ${JSON.stringify(tabLayout)}`);
  assert(tabLayout.tabCount >= 3 && tabLayout.topDelta !== null && tabLayout.topDelta <= 2, `${label} hub tabs are not aligned on one row: ${JSON.stringify(tabLayout)}`);
}

async function waitForApplication(page, baseUrl, homePath) {
  await page.waitForURL((url) => url.origin === baseUrl && !url.pathname.startsWith("/login"), { timeout: 30_000 });
  const path = new URL(page.url()).pathname;
  assert(path === homePath || (homePath === "/" && path === "/overview"), `unexpected post-login path: ${path}`);
}

async function logout(context, baseUrl) {
  return context.request.post(`${baseUrl}/api/auth/logout`, {
    headers: { origin: baseUrl, referer: `${baseUrl}/` },
  });
}

async function testApplication(browser, audience, configuration) {
  const account = accounts[audience];
  assert(typeof account?.email === "string" && typeof account?.password === "string", `${audience} credentials are missing`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const consoleProblems = [];
  const edgeInjectedConsoleProblems = [];
  const pageErrors = [];
  const failedResponses = [];
  const externalRequests = [];
  const edgeInjectedRequests = [];
  const credentialQueryAttempts = [];
  const origin = new URL(configuration.baseUrl).origin;

  await context.route("**/*", async (route) => {
    const url = route.request().url();
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol;
    if (parsedUrl.searchParams.has("password") || parsedUrl.searchParams.has("identifier")) {
      credentialQueryAttempts.push(safeUrl(url));
      return route.abort("blockedbyclient");
    }
    if (protocol === "data:" || protocol === "blob:" || parsedUrl.origin === origin) return route.continue();
    if (parsedUrl.origin === edgeInjectedScript.origin && parsedUrl.pathname.startsWith(edgeInjectedScript.pathPrefix)) {
      edgeInjectedRequests.push(safeUrl(url));
      return route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        headers: { "cache-control": "no-store" },
        body: "",
      });
    }
    externalRequests.push(safeUrl(url));
    return route.abort("blockedbyclient");
  });
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (message.text().includes(edgeInjectedScript.origin) && message.text().includes("integrity")) {
      edgeInjectedConsoleProblems.push(message.text());
      return;
    }
    consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: safeUrl(response.url()) });
  });

  let logoutCompleted = false;
  try {
  await page.goto(`${configuration.baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  assert(await page.locator("form").getAttribute("method") === "post", `${audience} login form does not fail closed before hydration`);
  await page.locator('input[name="identifier"]').fill(account.email);
  await page.locator('input[name="password"]').fill(account.password);
  const loginResponse = page.waitForResponse((response) => response.url() === `${configuration.baseUrl}/api/auth/login` && response.request().method() === "POST");
  await page.locator("form button.rc-primary").click();
  assert((await loginResponse).status() === 200, `${audience} login failed`);
  await waitForApplication(page, configuration.baseUrl, configuration.homePath);

  await page.locator("main h1").waitFor({ state: "visible", timeout: 30_000 });
  const mainHeadings = await page.locator("main h1").count();
  assert(mainHeadings === 1, `${audience} home must render exactly one h1; received ${mainHeadings}`);
  const primaryNavigation = page.locator("aside nav");
  for (const href of configuration.navigationHrefs) {
    assert(await primaryNavigation.locator(`a[href="${href}"]`).count() === 1, `${audience} navigation is missing ${href}`);
  }
  assert(await primaryNavigation.locator("a").count() === configuration.navigationHrefs.length, `${audience} navigation must contain exactly five primary entries`);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page, `${audience} home at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectCriticalAccessibility(page, `${audience} home`);

  const crossAudienceResponse = await context.request.get(configuration.crossAudienceUrl);
  assert(crossAudienceResponse.status() === 200, `${audience} cross-audience session projection must return a safe anonymous response`);
  const crossAudienceAnonymous = (await crossAudienceResponse.json())?.user === null;
  assert(crossAudienceAnonymous, `${audience} session cookie crossed an application audience boundary`);

  await page.goto(`${configuration.baseUrl}/settings?tab=appearance`, { waitUntil: "domcontentloaded" });
  if (audience !== "client") await expectHorizontalHubTabs(page, `${audience} settings`);
  const localeSelect = page.locator(".rc-preference-language select");
  await localeSelect.waitFor({ state: "visible" });
  assert(await localeSelect.locator("option").count() === configuration.localeOptionCount, `${audience} locale allowlist is incorrect`);
  const radioGroups = page.locator('[role="radiogroup"]');
  assert(await radioGroups.count() === 2, `${audience} appearance page must expose mode and palette groups`);
  const modeButtons = radioGroups.nth(0).locator('[role="radio"]');
  const paletteButtons = radioGroups.nth(1).locator('[role="radio"]');
  assert(await modeButtons.count() === 3 && await paletteButtons.count() === 3, `${audience} appearance options are incomplete`);

  for (let modeIndex = 0; modeIndex < themeModes.length; modeIndex += 1) {
    const mode = themeModes[modeIndex];
    await modeButtons.nth(modeIndex + 1).click();
    for (let paletteIndex = 0; paletteIndex < themePalettes.length; paletteIndex += 1) {
      const palette = themePalettes[paletteIndex];
      await paletteButtons.nth(paletteIndex).click();
      assert(await page.locator("html").getAttribute("data-theme") === mode, `${audience} failed to apply ${mode} mode`);
      const paletteAttribute = await page.locator("html").getAttribute("data-palette");
      assert(palette === "classic" ? paletteAttribute === null : paletteAttribute === palette, `${audience} failed to apply ${palette} palette`);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.scrollTo(0, 0);
      });
      await page.waitForFunction(() => window.scrollY === 0);
      await page.screenshot({ path: resolve(evidenceInput, `${audience}-${mode}-${palette}.png`), fullPage: true });
    }
  }

  const saveButton = page.locator(".rc-preference-section .rc-primary");
  const saveResponse = page.waitForResponse((response) => response.url() === `${configuration.baseUrl}/api/account/preferences` && response.request().method() === "PATCH");
  await saveButton.click();
  assert((await saveResponse).status() === 200, `${audience} preference save failed`);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert(await page.locator("html").getAttribute("data-theme") === "dark", `${audience} mode did not survive reload`);
  assert(await page.locator("html").getAttribute("data-palette") === "forest", `${audience} palette did not survive reload`);

  const groupsAfterReload = page.locator('[role="radiogroup"]');
  await groupsAfterReload.nth(0).locator('[role="radio"]').nth(0).click();
  await groupsAfterReload.nth(1).locator('[role="radio"]').nth(0).click();
  const resetSave = page.locator(".rc-preference-section .rc-primary");
  const resetResponse = page.waitForResponse((response) => response.url() === `${configuration.baseUrl}/api/account/preferences` && response.request().method() === "PATCH");
  await resetSave.click();
  assert((await resetResponse).status() === 200, `${audience} preference reset failed`);

  if (audience === "client") {
    await page.goto(`${configuration.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
    const notificationButton = page.locator('[aria-controls="client-notifications"]');
    await notificationButton.click();
    assert(await page.locator("#client-notifications").isVisible(), "client notification list did not open from the top bar");
    await page.keyboard.press("Escape");
    assert(!await page.locator("#client-notifications").isVisible(), "client notification list did not close with Escape");
  }

  const bodyText = await page.locator("body").innerText();
  assert(!/(?:BEGIN [A-Z ]+ PRIVATE KEY|postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|sk-[A-Za-z0-9]{20,})/.test(bodyText), `${audience} rendered secret-like material`);
  assert(externalRequests.length === 0, `${audience} made external browser requests: ${JSON.stringify(externalRequests)}`);
  assert(credentialQueryAttempts.length === 0, `${audience} attempted to place credentials in a URL`);
  assert(pageErrors.length === 0, `${audience} page errors: ${JSON.stringify(pageErrors)}`);
  assert(consoleProblems.length === 0, `${audience} console errors or warnings: ${JSON.stringify(consoleProblems)}`);
  assert(failedResponses.length === 0, `${audience} failed browser responses: ${JSON.stringify(failedResponses)}`);
  await expectCriticalAccessibility(page, `${audience} final page`);

  const logoutResponse = await logout(context, configuration.baseUrl);
  assert(logoutResponse.ok(), `${audience} logout failed`);
  logoutCompleted = true;
  return {
    audience,
    localeOptionCount: configuration.localeOptionCount,
    themeCount: themeModes.length * themePalettes.length,
    responsiveWidths: widths,
    crossAudienceAnonymous,
    edgeInjectedRequests: edgeInjectedRequests.length,
    edgeInjectedConsoleProblems: edgeInjectedConsoleProblems.length,
    externalRequests: externalRequests.length,
    credentialQueryAttempts: credentialQueryAttempts.length,
    consoleProblems: consoleProblems.length,
    pageErrors: pageErrors.length,
    failedResponses: failedResponses.length,
  };
  } finally {
    if (!logoutCompleted) {
      await logout(context, configuration.baseUrl).catch(() => undefined);
    }
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [audience, configuration] of Object.entries(applications)) {
    results.push(await testApplication(browser, audience, configuration));
  }
} finally {
  await browser.close();
}

const reportPath = resolve(evidenceInput, "acceptance-report.json");
await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`TEST_SITE_ACCEPTANCE_REPORT=${reportPath}\n`);
