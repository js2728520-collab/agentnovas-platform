import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  request as playwrightRequest,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { browserResourceBudget } from "../../../scripts/quality/browser-resource-budget.mjs";
import {
  isAllowedQualityNetworkUrl,
  isExpectedQualityBrowserWarning,
  qualityApplicationPorts,
  qualityBrowserOrigin,
  qualityLoopbackForward,
  redactPotentialSecrets,
} from "../../../scripts/quality/quality-policy.mjs";

type QualityFixtures = { qualityEvidence: void };
type QualityAudience = "client" | "operations" | "maintenance";

const audienceNavigationContract: Record<QualityAudience, {
  navigationName: string;
  requiredLabels: string[];
  forbiddenLabels: string[];
}> = {
  client: {
    // 客户端主导航只保留五个产品中心；个人偏好与账户动作由右上角用户菜单承载。
    navigationName: "客户导航",
    requiredLabels: ["数据看板", "交易中心", "策略中心", "行情", "AI 助手"],
    forbiddenLabels: ["运营概览", "客户管理", "系统概览", "模型与 Agent"],
  },
  operations: {
    navigationName: "运营端 导航",
    requiredLabels: ["运营看板", "客户与账户", "商业与财务", "运营治理"],
    forbiddenLabels: ["运营概览", "客户管理", "会员订单", "系统概览", "模型与 Agent"],
  },
  maintenance: {
    navigationName: "运维端 导航",
    requiredLabels: ["系统运行", "AI 与策略", "外部集成", "平台配置", "发布与安全"],
    forbiddenLabels: ["系统概览", "系统健康", "工作记录导出", "模型与 Agent", "配置发布", "版本发布", "运营概览", "客户管理", "会员订单"],
  },
};

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
    const fixtureForwarder = await playwrightRequest.newContext();
    let closing = false;

    // Official Playwright network/service-worker guidance:
    // https://playwright.dev/docs/network
    // https://playwright.dev/docs/service-workers
    await context.route("**/*", async (route) => {
      const browserRequest = route.request();
      const url = browserRequest.url();
      const parsed = new URL(url);
      const forward = parsed.protocol === "https:"
        ? qualityLoopbackForward(url, qualityApplicationPorts(process.env))
        : null;
      if (forward) {
        const requestHeaders = await browserRequest.allHeaders();
        const postData = browserRequest.postDataBuffer();
        try {
          const response = await fixtureForwarder.fetch(forward.url, {
            method: browserRequest.method(),
            timeout: 10_000,
            maxRedirects: 0,
            ...(postData ? { data: postData } : {}),
            headers: {
              ...requestHeaders,
              host: forward.host,
              "x-forwarded-for": "127.0.0.1",
              "x-forwarded-proto": "https",
            },
          });
          await route.fulfill({ response });
        } catch (error) {
          if (closing) return;
          throw new Error(`quality loopback fulfill failed for ${safeUrl(url)}: ${redactPotentialSecrets(error instanceof Error ? error.message : String(error))}`);
        }
      } else if (isAllowedQualityNetworkUrl(url)) await route.continue();
      else {
        externalRequests.push(safeUrl(url));
        await route.abort("blockedbyclient");
      }
    });
    page.on("console", (message) => {
      if (closing) return;
      if (message.type() === "error" || message.type() === "warning") {
        consoleProblems.push(redactPotentialSecrets(message.text()));
      }
    });
    page.on("pageerror", (error) => {
      if (!closing) pageErrors.push(redactPotentialSecrets(error.message));
    });
    page.on("requestfailed", (request) => {
      if (closing) return;
      if (isAllowedQualityNetworkUrl(request.url())) {
        const headers = request.headers();
        const failure = request.failure()?.errorText ?? "failed";
        const expectedNextPrefetchCancellation = failure === "net::ERR_ABORTED"
          && request.resourceType() === "fetch"
          && !request.isNavigationRequest()
          && headers["next-router-prefetch"] === "1";
        const expectedOptimizedImageCancellation = failure === "net::ERR_ABORTED"
          && request.resourceType() === "image"
          && new URL(request.url()).pathname === "/_next/image";
        if (expectedNextPrefetchCancellation || expectedOptimizedImageCancellation) return;
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
      if (closing) return;
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
    closing = true;
    await fixtureForwarder.dispose({ reason: "quality evidence complete" });
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
    const unexpectedConsoleProblems = consoleProblems.filter((message) => !isExpectedQualityBrowserWarning(message));
    expect(unexpectedConsoleProblems, `browser console errors/warnings: ${safeEntry(unexpectedConsoleProblems)}`).toEqual([]);
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
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const overflow = await page.evaluate(() => {
    const elements = [document.body, ...Array.from(document.querySelectorAll<HTMLElement>("body *"))];
    const measurements = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        id: element.id,
        className: element.className,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: style.overflowX,
        display: style.display,
        position: style.position,
      };
    });
    const clientWidth = document.documentElement.clientWidth;
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: measurements
        .filter((item) => item.left < -1 || item.right > clientWidth + 1)
        .sort((a, b) => (b.right - clientWidth) - (a.right - clientWidth))
        .slice(0, 12),
      overflowingContents: measurements
        .filter((item) => item.scrollWidth > item.clientWidth + 1)
        .sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth))
        .slice(0, 12),
    };
  });
  expect(
    overflow.scrollWidth,
    JSON.stringify({ offenders: overflow.offenders, overflowingContents: overflow.overflowingContents }),
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

export async function expectKeyboardEntry(page: Page) {
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  await expect(focused).not.toHaveJSProperty("tagName", "BODY");
}

export async function expectInitialResourceBudget(page: Page) {
  const resources = await page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      encodedBodySize: entry.encodedBodySize,
      transferSize: entry.transferSize,
    })));
  const bytes = await browserResourceBudget(process.cwd(), resources);
  expect(bytes.scripts, "initial script transfer budget").toBeLessThanOrEqual(200 * 1024);
  expect(bytes.styles, "initial stylesheet transfer budget").toBeLessThanOrEqual(50 * 1024);
  expect(bytes.largestImage, "single initial image transfer budget").toBeLessThanOrEqual(200 * 1024);
}

export async function expectAudienceNavigation(page: Page, audience: QualityAudience) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const contract = audienceNavigationContract[audience];
  const navigation = page.getByRole("navigation", { name: contract.navigationName });
  await expect(navigation).toBeVisible();
  for (const label of contract.requiredLabels) {
    await expect(navigation.getByRole("link", { name: label, exact: true }), `${audience} navigation must expose ${label}`).toBeVisible();
  }
  for (const label of contract.forbiddenLabels) {
    await expect(navigation.getByRole("link", { name: label, exact: true }), `${audience} navigation must not expose ${label}`).toHaveCount(0);
  }
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

export async function createIsolatedQualityBrowser(
  browser: Browser,
  audience: QualityAudience,
) {
  const externalRequests: string[] = [];
  const consoleProblems: string[] = [];
  const pageErrors: string[] = [];
  const failedLocalRequests: string[] = [];
  const unsuccessfulResponses: Array<{ method: string; url: string; status: number }> = [];
  let closing = false;
  const ports = qualityApplicationPorts(process.env);
  const origin = qualityBrowserOrigin(audience, ports).baseURL;
  const forwarder = await playwrightRequest.newContext();
  const context: BrowserContext = await browser.newContext({
    baseURL: origin,
    acceptDownloads: false,
    serviceWorkers: "block",
    storageState: { cookies: [], origins: [] },
  });

  await context.route("**/*", async (route) => {
    const browserRequest = route.request();
    const url = browserRequest.url();
    const parsed = new URL(url);
    const forward = parsed.protocol === "https:" ? qualityLoopbackForward(url, ports) : null;
    if (forward) {
      const requestHeaders = await browserRequest.allHeaders();
      const postData = browserRequest.postDataBuffer();
      try {
        const response = await forwarder.fetch(forward.url, {
          method: browserRequest.method(),
          timeout: 10_000,
          maxRedirects: 0,
          ...(postData ? { data: postData } : {}),
          headers: {
            ...requestHeaders,
            host: forward.host,
            "x-forwarded-for": "127.0.0.1",
            "x-forwarded-proto": "https",
          },
        });
        await route.fulfill({ response });
      } catch (error) {
        if (closing) return;
        throw new Error(`isolated loopback fulfill failed for ${safeUrl(url)} (${route.request().resourceType()}, navigation=${route.request().isNavigationRequest()}, closing=${closing}, failure=${route.request().failure()?.errorText ?? "none"}, prefetch=${requestHeaders["next-router-prefetch"] ?? "none"}, purpose=${requestHeaders.purpose ?? requestHeaders["sec-purpose"] ?? "none"}): ${redactPotentialSecrets(error instanceof Error ? error.message : String(error))}`);
      }
    } else if (isAllowedQualityNetworkUrl(url)) await route.continue();
    else {
      externalRequests.push(safeUrl(url));
      await route.abort("blockedbyclient");
    }
  });
  context.on("page", (openedPage) => {
    openedPage.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleProblems.push(redactPotentialSecrets(message.text()));
      }
    });
    openedPage.on("pageerror", (error) => pageErrors.push(redactPotentialSecrets(error.message)));
    openedPage.on("requestfailed", (request) => {
      if (closing) return;
      if (!isAllowedQualityNetworkUrl(request.url())) return;
      const failure = request.failure()?.errorText ?? "failed";
      const headers = request.headers();
      const expectedPrefetchCancellation = failure === "net::ERR_ABORTED"
        && request.resourceType() === "fetch"
        && !request.isNavigationRequest()
        && headers["next-router-prefetch"] === "1";
      const expectedOptimizedImageCancellation = failure === "net::ERR_ABORTED"
        && request.resourceType() === "image"
        && new URL(request.url()).pathname === "/_next/image";
      if (!expectedPrefetchCancellation && !expectedOptimizedImageCancellation) failedLocalRequests.push(safeUrl(request.url()));
    });
    openedPage.on("response", (response) => {
      if (response.status() >= 400) {
        unsuccessfulResponses.push({
          method: response.request().method(),
          url: safeUrl(response.url()),
          status: response.status(),
        });
      }
    });
  });

  const page = await context.newPage();
  return {
    context,
    origin,
    page,
    async close(options: { allowedStatuses?: number[] } = {}) {
      closing = true;
      const allowedStatuses = new Set(options.allowedStatuses ?? []);
      const unexpectedResponses = unsuccessfulResponses.filter(({ status }) => !allowedStatuses.has(status));
      const expectedResourceFailure = new RegExp(
        `^Failed to load resource: the server responded with a status of (?:${[...allowedStatuses].join("|")}) \\(.+\\)$`,
      );
      const unexpectedConsoleProblems = (allowedStatuses.size
        ? consoleProblems.filter((message) => !expectedResourceFailure.test(message))
        : consoleProblems).filter((message) => !isExpectedQualityBrowserWarning(message));
      let evidenceFailure: unknown;
      try {
        expect(externalRequests, "isolated browser external requests").toEqual([]);
        expect(
          unexpectedConsoleProblems,
          `isolated browser console errors/warnings; HTTP failures: ${safeEntry(unexpectedResponses)}`,
        ).toEqual([]);
        expect(pageErrors, "isolated browser page errors").toEqual([]);
        expect(failedLocalRequests, "isolated browser failed local requests").toEqual([]);
        expect(unexpectedResponses, "isolated browser unexpected HTTP responses").toEqual([]);
      } catch (error) {
        evidenceFailure = error;
      }
      const cleanupFailures: unknown[] = [];
      const cleanupSteps: Array<() => Promise<unknown>> = [
        async () => { if (!page.isClosed()) await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }); },
        () => forwarder.dispose({ reason: "quality evidence complete" }),
        async () => { if (!page.isClosed()) await page.close({ runBeforeUnload: false }); },
        () => context.close({ reason: "quality evidence complete" }),
      ];
      for (const cleanup of cleanupSteps) {
        try {
          await cleanup();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (evidenceFailure) throw evidenceFailure;
      if (cleanupFailures.length) throw cleanupFailures[0];
    },
  };
}
