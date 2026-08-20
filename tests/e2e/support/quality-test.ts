import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

import {
  isAllowedQualityNetworkUrl,
  redactPotentialSecrets,
} from "../../../scripts/quality/quality-policy.mjs";

type QualityFixtures = { qualityEvidence: void };

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return "[invalid-url]";
  }
}

function safeEntry(value: unknown) {
  return redactPotentialSecrets(JSON.stringify(value));
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: "application/json",
  });
}

export const test = base.extend<QualityFixtures>({
  qualityEvidence: [async ({ context, page }, use, testInfo) => {
    const externalRequests: string[] = [];
    const consoleProblems: string[] = [];
    const pageErrors: string[] = [];
    const failedLocalRequests: string[] = [];
    const responses: Array<{ method: string; url: string; status: number; resourceType: string }> = [];

    // Official Playwright network/service-worker guidance:
    // https://playwright.dev/docs/network
    // https://playwright.dev/docs/service-workers
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isAllowedQualityNetworkUrl(url)) await route.continue();
      else {
        externalRequests.push(safeUrl(url));
        await route.abort("blockedbyclient");
      }
    });
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleProblems.push(redactPotentialSecrets(message.text()));
      }
    });
    page.on("pageerror", (error) => pageErrors.push(redactPotentialSecrets(error.message)));
    page.on("requestfailed", (request) => {
      if (isAllowedQualityNetworkUrl(request.url())) {
        const headers = request.headers();
        const failure = request.failure()?.errorText ?? "failed";
        const expectedNextPrefetchCancellation = failure === "net::ERR_ABORTED"
          && request.resourceType() === "fetch"
          && !request.isNavigationRequest()
          && headers["next-router-prefetch"] === "1";
        if (expectedNextPrefetchCancellation) return;
        failedLocalRequests.push(safeEntry({
          method: request.method(),
          url: safeUrl(request.url()),
          failure,
          resourceType: request.resourceType(),
          navigation: request.isNavigationRequest(),
          purpose: headers.purpose ?? headers["sec-purpose"] ?? null,
          nextRouterPrefetch: headers["next-router-prefetch"] ?? null,
        }));
      }
    });
    page.on("response", (response) => {
      if (responses.length < 500) {
        responses.push({
          method: response.request().method(),
          url: safeUrl(response.url()),
          status: response.status(),
          resourceType: response.request().resourceType(),
        });
      }
    });

    await use();
    await attachJson(testInfo, "network-summary", responses);
    await attachJson(testInfo, "console-summary", {
      consoleProblems,
      pageErrors,
      failedLocalRequests,
      externalRequests,
    });
    const unsuccessfulResponses = responses.filter(({ status }) => status >= 400);
    expect(externalRequests, `external requests escaped the loopback allowlist: ${safeEntry(externalRequests)}`).toEqual([]);
    expect(pageErrors, `uncaught page errors: ${safeEntry(pageErrors)}`).toEqual([]);
    expect(unsuccessfulResponses, `unsuccessful browser responses: ${safeEntry(unsuccessfulResponses)}`).toEqual([]);
    expect(consoleProblems, `browser console errors/warnings: ${safeEntry(consoleProblems)}`).toEqual([]);
    expect(failedLocalRequests, `failed local requests: ${safeEntry(failedLocalRequests)}`).toEqual([]);
  }, { auto: true }],
});

export { expect } from "@playwright/test";

export async function expectCriticalAccessibility(page: Page) {
  // Official Playwright axe integration guidance:
  // https://playwright.dev/docs/accessibility-testing
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const severe = result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  expect(severe, JSON.stringify(severe, null, 2)).toEqual([]);
}

export async function expectResponsivePage(page: Page) {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

export async function expectKeyboardEntry(page: Page) {
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  await expect(focused).not.toHaveJSProperty("tagName", "BODY");
}

export async function expectInitialResourceBudget(page: Page) {
  const bytes = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const total = (kind: string) => resources
      .filter((entry) => entry.initiatorType === kind)
      .reduce((sum, entry) => sum + (entry.encodedBodySize || entry.transferSize || 0), 0);
    return { scripts: total("script"), styles: total("link"), images: total("img") };
  });
  expect(bytes.scripts, "initial script transfer budget").toBeLessThanOrEqual(200 * 1024);
  expect(bytes.styles, "initial stylesheet transfer budget").toBeLessThanOrEqual(50 * 1024);
  expect(bytes.images, "initial image transfer budget").toBeLessThanOrEqual(200 * 1024);
}

export async function exerciseResponsiveWidths(page: Page, path: string, heading: string | RegExp) {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    await expectResponsivePage(page);
  }
  await expectKeyboardEntry(page);
  await expectCriticalAccessibility(page);
  await expectInitialResourceBudget(page);
}
