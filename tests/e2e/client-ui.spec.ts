import { exerciseResponsiveWidths, expect, expectAudienceNavigation, expectCriticalAccessibility, expectResponsivePage, test } from "./support/quality-test";
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

/**
 * 策略广场与我的跟单的真实浏览器旅程（4.12）。
 *
 * 这两个工作区此前只有源码契约断言——「披露未勾选时按钮不可用」是靠正则匹配源码验证的，
 * 没人真的点过。源码断言证明不了控件真的被禁用、也证明不了 axe 能过。
 */
async function exerciseStrategyMarketplace(page: import("@playwright/test").Page) {
  const liveOrderRequests: string[] = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && (pathname.includes("/orders") || pathname.includes("/deployments"))) {
      liveOrderRequests.push(pathname);
    }
  });
  await page.goto("/marketplace");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("策略广场");

  // 夹具里有一条已上架策略。空态说明夹具没生效，那会让下面所有断言变成假阳性。
  const card = page.getByRole("button", { name: /Quality 广场策略/ });
  await expect(card).toBeVisible();
  await card.click();

  // 只展示历史表现，不展示策略逻辑（需求方 2026-08-24 确认）。
  await expect(page.getByText("跟随人数", { exact: true })).toBeVisible();
  await expect(page.getByText("回测净收益")).toBeVisible();
  await expect(page.getByText(/回测区间：\d{4}-\d{2}-\d{2}/)).toBeVisible();
  // 条件树、DSL 字段一律不得出现在页面上。
  await expect(page.getByText(/price_ema|candle_direction|schemaVersion/)).toHaveCount(0);

  // 披露未勾选时按钮不可用——这条此前只有源码断言。
  const follow = page.getByRole("button", { name: "开启模拟跟单" });
  await expect(follow).toBeDisabled();
  await page.getByLabel("我已阅读并理解上述风险披露").check();
  await expect(follow).toBeEnabled();

  // 止损线的说明必须写清它就是自动风控的停机线。
  await expect(page.getByText(/累计回撤触及这条线时，系统自动阻断该跟单的新开仓/)).toBeVisible();

  // 筛选和排序在浏览器中实际生效；当前质量夹具只有一条正收益策略，结果数仍必须可见。
  await page.getByLabel("按收益区间筛选").selectOption("positive");
  await expect(page.getByRole("status")).toContainText("显示 1 / 1 个策略");
  await page.getByLabel("策略排序").selectOption("return");
  await expect(page.getByRole("button", { name: /Quality 广场策略/ })).toBeVisible();

  await expect(liveOrderRequests).toEqual([]);
  await expectCriticalAccessibility(page);
  await expectResponsivePage(page);
}

async function exerciseFollowResults(page: import("@playwright/test").Page) {
  await page.goto("/follows");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("我的跟单");
  // 还没跟单时是空态；模拟盘的性质无论有没有跟单都要说清。
  await expect(page.getByText(/不产生真实订单，也不可提取/)).toBeVisible();
  await expectCriticalAccessibility(page);
  await expectResponsivePage(page);
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

async function exerciseMarketWithoutWatchlist(page: import("@playwright/test").Page) {
  const marketRequests: string[] = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/market/")) marketRequests.push(pathname);
  });
  await page.route("**/api/market/instruments", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ instruments: [{
      symbol: "AAPL",
      label: "AAPL",
      name: "Apple Inc.",
      nameZh: "苹果",
      category: "stocks",
      providerSymbol: "AAPL",
      aliases: ["apple", "苹果"],
    }] }),
  }));
  await page.route("**/api/market/quote?*", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ price: 200, change: 2, changePercent: 1, high: 202, low: 197, volume: 1_000_000, open: 198, live: true, source: "quality fixture", updatedAt: new Date().toISOString() }),
  }));
  await page.route("**/api/market/candles?*", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ candles: [{ time: Date.now() - 60_000, open: 198, high: 201, low: 197, close: 200, volume: 1_000 }] }),
  }));
  await page.route("**/api/market/news?*", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], observedAt: new Date().toISOString(), contentFreshness: "unavailable", stale: true, live: false }),
  }));

  await exerciseResponsiveWidths(page, "/market", "行情中心");
  await expect(page.getByLabel("搜索交易品种")).toBeVisible();
  await expect(page.getByText("品种索引", { exact: true })).toBeVisible();
  await expect(page.getByText(/关注产品|观察名单|Watchlist/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /收藏|关注|Watch/ })).toHaveCount(0);
  expect(marketRequests.some(pathname => pathname === "/api/market/watchlist")).toBe(false);
}

async function exerciseAssistantCancellationWithoutDialog(page: import("@playwright/test").Page) {
  const conversationId = "10000000-0000-4000-8000-000000000001";
  const inferenceRequestId = "20000000-0000-4000-8000-000000000002";
  const userMessageId = "30000000-0000-4000-8000-000000000003";
  const question = "请分析取消生成时的资金安全";
  let dialogs = 0;
  page.on("dialog", async dialog => {
    dialogs += 1;
    await dialog.dismiss();
  });
  await page.addInitScript(({ conversationId: seededConversationId, inferenceRequestId: seededInferenceRequestId, userMessageId: seededUserMessageId, question: seededQuestion }) => {
    const originalFetch = window.fetch.bind(window);
    const evidence = { messageRequests: 0, cancelRequests: 0, cancelIdempotencyKey: "", cancelBody: "" };
    (window as Window & { __assistantCancellationEvidence?: typeof evidence }).__assistantCancellationEvidence = evidence;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/ai/conversations" && method === "GET") {
        return Response.json({ conversations: [{
          id: seededConversationId,
          title: "取消测试会话",
          purpose: "consultation",
          messageCount: 0,
          lastMessageAt: new Date().toISOString(),
        }] });
      }
      if (url.pathname === `/api/ai/conversations/${seededConversationId}` && method === "GET") {
        return Response.json({ messages: [] });
      }
      if (url.pathname === `/api/ai/conversations/${seededConversationId}/messages` && method === "POST") {
        evidence.messageRequests += 1;
        const signal = init?.signal ?? request?.signal;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({
              conversationId: seededConversationId,
              title: "取消测试会话",
              inferenceRequestId: seededInferenceRequestId,
              userMessage: {
                id: seededUserMessageId,
                role: "user",
                content: seededQuestion,
                createdAt: new Date().toISOString(),
              },
            })}\n\n`));
            signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
      }
      if (url.pathname === `/api/ai/inferences/${seededInferenceRequestId}/cancel` && method === "POST") {
        evidence.cancelRequests += 1;
        const headers = new Headers(init?.headers ?? request?.headers);
        evidence.cancelIdempotencyKey = headers.get("idempotency-key") ?? "";
        evidence.cancelBody = typeof init?.body === "string" ? init.body : "";
        return Response.json({ inference: {
          id: seededInferenceRequestId,
          state: "cancelled",
          creditsDisposition: "released",
          created: true,
        } });
      }
      return originalFetch(input, init);
    };
  }, { conversationId, inferenceRequestId, userMessageId, question });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/assistant", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "AI 助手", level: 1 })).toBeVisible();
  await page.getByLabel("AI 对话内容").fill(question);
  await page.getByRole("button", { name: "发送问题" }).click();
  const cancelButton = page.getByRole("button", { name: "取消生成" });
  await expect(cancelButton).toBeVisible();
  await cancelButton.click();
  await expect(page.getByRole("status").filter({ hasText: "生成已取消" })).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  await expect(page.getByText("AI 团队", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const state = (window as Window & { __assistantCancellationEvidence?: { messageRequests: number; cancelRequests: number; cancelIdempotencyKey: string; cancelBody: string } }).__assistantCancellationEvidence;
    return state ?? null;
  })).toEqual({
    messageRequests: 1,
    cancelRequests: 1,
    cancelIdempotencyKey: expect.stringMatching(/^cancel-[0-9a-f-]{36}$/),
    cancelBody: "",
  });
  expect(dialogs).toBe(0);
  await expectResponsivePage(page);
  await expectCriticalAccessibility(page);
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
  await exerciseAssistantCancellationWithoutDialog(page);
  await expectAudienceNavigation(page, "client");
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

test("client market keeps search and live evidence without the retired watchlist", async ({ page }) => {
  await exerciseMarketWithoutWatchlist(page);
  await expectAudienceNavigation(page, "client");
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
    ["/work-records", "工作记录"],
    ["/performance-statements", "绩效账单"],
    ["/legal/consent", "商业披露与版本确认"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
});

/**
 * 策略广场与我的跟单单独成一条用例。
 *
 * 不并进上面那条商业/模拟盘用例：它已经跑 11 个路由 × 4 断点 × axe，再加两个页面会超过
 * Playwright 的 60 秒单测预算——症状是候选编辑器「找不到元素」，看起来像功能坏了，实际
 * 是前面的页面把时间用光了。调大超时会掩盖这个信号：一条 60 秒的用例本身就在说它做得太多。
 */
test("client strategy marketplace and follow results are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/marketplace", "策略广场"],
    ["/follows", "我的跟单"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
  await exerciseStrategyMarketplace(page);
  await exerciseFollowResults(page);
});

/**
 * 可编辑策略候选单独成一条用例。
 *
 * 它原本挂在上面那条商业/模拟盘用例的末尾，而那条已经跑 11 个路由 × 4 断点 × axe，
 * 逼近 Playwright 的 60 秒单测预算。启用策略广场接口后 `/paper` 那几页从「503 秒回」
 * 变成真的查数据，累计时间被顶出预算——症状是候选编辑器「找不到元素」，实际页面还停在
 * 「正在验证客户端会话…」。
 *
 * 调大超时会掩盖这个信号：一条 60 秒的用例本身就在说它做得太多。拆开之后每条各有预算，
 * 而且下次谁超时了一眼能看出是哪一段。
 */
test("client editable strategy candidate saves an immutable draft without deploying", async ({ page }) => {
  await exerciseEditableStrategyCandidate(page);
});
