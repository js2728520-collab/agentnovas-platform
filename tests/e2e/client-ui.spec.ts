import { exerciseResponsiveWidths, expect, expectAudienceNavigation, test } from "./support/quality-test";
import { readQualityRuntime } from "./support/runtime";

const localeStorageKey = "riverton.platform-locale";
const qualityBrowserLanguageKey = "riverton.quality-browser-language";

async function exercisePublicLocalePreference(page: import("@playwright/test").Page) {
  await page.addInitScript(({ browserLanguageKey }) => {
    const forcedLanguage = window.localStorage.getItem(browserLanguageKey) ?? "fr-FR";
    Object.defineProperty(window.navigator, "languages", { configurable: true, get: () => [forcedLanguage] });
    Object.defineProperty(window.navigator, "language", { configurable: true, get: () => forcedLanguage });
  }, { browserLanguageKey: qualityBrowserLanguageKey });

  await page.goto("/");
  await page.evaluate(({ browserLanguageKey, storageKey }) => {
    window.localStorage.setItem(browserLanguageKey, "fr-FR");
    window.localStorage.removeItem(storageKey);
  }, { browserLanguageKey: qualityBrowserLanguageKey, storageKey: localeStorageKey });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByLabel("Language")).toHaveValue("en-US");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("An AI quant team working for you");

  await page.evaluate(({ browserLanguageKey, storageKey }) => {
    window.localStorage.setItem(browserLanguageKey, "zh-CN");
    window.localStorage.removeItem(storageKey);
  }, { browserLanguageKey: qualityBrowserLanguageKey, storageKey: localeStorageKey });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByLabel("Language")).toHaveValue("zh-CN");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("一支为你工作的 AI 量化团队");

  await page.getByLabel("Language").selectOption("es-ES");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Un equipo cuantitativo de IA trabajando para ti");
  await page.evaluate((browserLanguageKey) => window.localStorage.setItem(browserLanguageKey, "ko-KR"), qualityBrowserLanguageKey);
  await page.reload();
  await expect(page.getByLabel("Language")).toHaveValue("es-ES");

  await page.evaluate(({ browserLanguageKey, storageKey }) => {
    window.localStorage.setItem(browserLanguageKey, "fr-FR");
    window.localStorage.setItem(storageKey, "<script>");
  }, { browserLanguageKey: qualityBrowserLanguageKey, storageKey: localeStorageKey });
  await page.reload();
  await expect(page.getByLabel("Language")).toHaveValue("en-US");
}

async function exerciseEditableStrategyCandidate(page: import("@playwright/test").Page) {
  const runtime = await readQualityRuntime();
  const { runId, candidateId, exchangeAccountId } = runtime.researchFixture;
  const candidateSpecification = {
    schemaVersion: 3,
    name: "Quality BTC trend candidate",
    market: "usdt_perpetual",
    marginMode: "isolated",
    leverage: 1,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "long_only",
    legs: {
      long: {
        entry: { all: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" }] },
        exit: { any: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" }] },
        stopLossPct: 2,
        takeProfitPct: 4,
      },
    },
    risk: {
      positionSizePct: 3,
      maxDrawdownPct: 10,
      maxDailyLossPct: 2,
      maxConsecutiveLosses: 3,
    },
  };
  let savedSpecification: typeof candidateSpecification | null = null;
  let savedRequestPositionSizePct: number | null = null;
  await page.route("**/api/exchange-accounts", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ accounts: [{
      id: exchangeAccountId,
      label: "Quality read-only market account",
      exchange: "OKX",
      status: "active",
      canRead: true,
      withdrawalAuthorized: false,
    }] }),
  }));
  await page.route("**/api/strategy-research/roles", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ roles: [], ready: false }),
  }));
  await page.route("**/api/strategy-research/runs?*", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ runs: [{
      id: runId,
      exchangeAccountId,
      mode: "standard",
      stage: "completed",
      status: "completed",
      progress: 100,
      brief: {
        target: { instrumentId: "BTC-USDT-SWAP", symbol: "BTCUSDT", timeframe: "1h", direction: "long_only" },
      },
      finalConclusion: "QUALIFIED",
    }] }),
  }));
  await page.route(`**/api/exchange-accounts/${exchangeAccountId}/perpetual-instruments?*`, async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ instruments: [{
      exchange: "okx",
      symbol: "BTCUSDT",
      exchangeSymbol: "BTC-USDT-SWAP",
      status: "live",
      quoteAsset: "USDT",
      tickSize: 0.1,
      lotSize: 0.001,
      fundingIntervalHours: 8,
    }] }),
  }));
  await page.route(`**/api/strategy-research/runs/${runId}`, async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      run: {
        id: runId,
        status: "completed",
        stage: "completed",
        progress: 100,
        result: { qualityFixture: true },
        finalConclusion: "QUALIFIED",
        lastErrorMessage: null,
      },
      events: [],
      candidates: [{
        id: candidateId,
        strategyFamily: "EMA trend",
        sourceRole: "proposal_a",
        dsl: savedSpecification ?? candidateSpecification,
        status: "qualified",
        rank: 1,
        score: 88.5,
        rejectionReasons: [],
        validationLabel: savedSpecification ? "UNVERIFIED" : "STANDARD_VERIFIED",
        savedStrategyId: savedSpecification ? candidateId : null,
        savedStrategyVersionId: savedSpecification ? `${candidateId}-v1` : null,
        edited: Boolean(savedSpecification),
      }],
      evaluations: [{
        candidateId,
        kind: "holdout",
        metrics: { netReturnPct: 12.5, maxDrawdownPct: 7.25, profitFactor: 1.8, sampleSize: 120 },
        passed: true,
        finalHoldout: true,
      }],
    }),
  }));
  await page.route(`**/api/strategy-research/runs/${runId}/events?*`, async route => route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    body: `event: done\ndata: ${JSON.stringify({ status: "completed" })}\n\n`,
  }));
  await page.route(`**/api/strategy-research/runs/${runId}/candidates/${candidateId}/save`, async route => {
    const body = route.request().postDataJSON() as { specification?: typeof candidateSpecification };
    savedSpecification = body.specification ?? null;
    savedRequestPositionSizePct = savedSpecification?.risk.positionSizePct ?? null;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        strategyId: candidateId,
        version: 1,
        versionId: `${candidateId}-v1`,
        created: true,
        edited: true,
        specification: savedSpecification,
        validationLabel: "UNVERIFIED",
        simulationOnly: true,
      }),
    });
  });

  let saveRequests = 0;
  let deploymentRequests = 0;
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname.endsWith(`/candidates/${candidateId}/save`)) saveRequests += 1;
    if (request.method() === "POST" && pathname.endsWith("/deployments")) deploymentRequests += 1;
  });

  await page.goto("/studio", { waitUntil: "domcontentloaded" });
  const textarea = page.locator(`textarea[data-candidate-id="${candidateId}"]`);
  const candidateCard = textarea.locator("xpath=ancestor::article[1]");
  await expect(candidateCard.getByText("STANDARD_VERIFIED", { exact: true })).toBeVisible();
  await expect(candidateCard.getByText("88.50", { exact: true })).toBeVisible();
  await candidateCard.getByText("结构化策略参数", { exact: true }).click();
  await expect(textarea).toBeVisible();

  await textarea.fill('{"schemaVersion":3');
  await candidateCard.getByRole("button", { name: "保存并创建不可变草稿" }).click();
  await expect(candidateCard.getByRole("alert")).toContainText("JSON 格式无效");
  expect(saveRequests).toBe(0);

  const edited = {
    ...candidateSpecification,
    risk: { ...candidateSpecification.risk, positionSizePct: 4 },
  };
  await textarea.fill(JSON.stringify(edited, null, 2));
  const saveResponsePromise = page.waitForResponse(response =>
    response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/candidates/${candidateId}/save`),
  );
  await candidateCard.getByRole("button", { name: "保存并创建不可变草稿" }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status()).toBe(201);
  const savePayload = await saveResponse.json();
  expect(savePayload.validationLabel).toBe("UNVERIFIED");
  expect(savePayload.edited).toBe(true);
  expect(savePayload.specification.risk.positionSizePct).toBe(4);
  expect(savedRequestPositionSizePct).toBe(4);
  expect(saveRequests).toBe(1);
  expect(deploymentRequests).toBe(0);
  await expect(candidateCard.getByText("UNVERIFIED", { exact: true })).toBeVisible();
  await expect(candidateCard.getByText("需重测", { exact: true })).toBeVisible();
  await expect(candidateCard.getByText(/原评分与回测指标已失效/)).toBeVisible();
  await expect(textarea).toBeDisabled();

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedTextarea = page.locator(`textarea[data-candidate-id="${candidateId}"]`);
  const reloadedCard = reloadedTextarea.locator("xpath=ancestor::article[1]");
  await reloadedCard.getByText("结构化策略参数", { exact: true }).click();
  await expect(reloadedTextarea).toBeDisabled();
  await expect(reloadedTextarea).toHaveValue(/"positionSizePct": 4/);
  await expect(reloadedCard.getByText("UNVERIFIED", { exact: true })).toBeVisible();
  await expect(reloadedCard.getByText("需重测", { exact: true })).toBeVisible();
  await expect(reloadedCard.getByText(/原评分与回测指标已失效/)).toBeVisible();
  expect(saveRequests).toBe(1);
  expect(deploymentRequests).toBe(0);
}

test("public locale and client communication workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  await exercisePublicLocalePreference(page);
  for (const [path, heading] of [
    ["/notifications", "通知中心"],
    ["/account/security", "账号与登录安全"],
    ["/support", "支持与公告"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
});

test("client wallet boundaries are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/wallet", "钱包与账本"],
    ["/wallet/deposits", "USDT 充值与订单"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
});

test("client commercial and paper workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    // ADR-0017：`/` 只属于公开着陆页，不渲染客户工作台；登录后的稳定总览是 `/dashboard`。
    // 这条用例原来指向 `/` 并断言「客户工作台」——那个路由现在返回营销页，
    // 而那个标题在客户端 UI 里也已经不存在（首页 h1 是个人化问候）。
    ["/dashboard", "欢迎回来"],
    ["/membership", "会员与 AI 积分"],
    ["/membership/orders", "会员与 AI 积分"],
    ["/credits", "AI 积分"],
    ["/paper", "交易中心"],
    // /paper 是「交易中心」，/trading-hall 是「交易大厅」——两个页面两个标题，
    // 原来两条都写成「交易中心」。
    ["/trading-hall", "交易大厅"],
    ["/performance-statements", "绩效账单"],
    ["/legal/consent", "商业披露与版本确认"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
  await exerciseEditableStrategyCandidate(page);
});
