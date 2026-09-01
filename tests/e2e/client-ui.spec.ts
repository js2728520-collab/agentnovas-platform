import { createIsolatedQualityBrowser, exerciseResponsiveWidths, expect, expectAudienceNavigation, expectCriticalAccessibility, expectResponsivePage, test } from "./support/quality-test";

const localeStorageKey = "riverton.platform-locale";
const qualityBrowserLanguageKey = "riverton.quality-browser-language";

async function exercisePublicLocalePreference(page: import("@playwright/test").Page) {
  await page.addInitScript(({ browserLanguageKey }) => {
    const forcedLanguage = window.localStorage.getItem(browserLanguageKey) ?? "fr-FR";
    Object.defineProperty(window.navigator, "languages", { configurable: true, get: () => [forcedLanguage] });
    Object.defineProperty(window.navigator, "language", { configurable: true, get: () => forcedLanguage });
  }, { browserLanguageKey: qualityBrowserLanguageKey });

  await page.goto("/");
  await page.getByLabel("Language").selectOption("en-US");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByLabel("Language")).toHaveValue("en-US");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("An AI quant team working for you");

  await page.getByLabel("Language").selectOption("zh-CN");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("一支为你工作的 AI 量化团队");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByLabel("Language")).toHaveValue("zh-CN");

  await page.getByLabel("Language").selectOption("es-ES");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Un equipo cuantitativo de IA trabajando para ti");
  await expect.poll(() => page.evaluate((storageKey) => ({
    storage: window.localStorage.getItem(storageKey),
    cookie: document.cookie.split("; ").includes("rv_locale_client=es-ES"),
  }), localeStorageKey)).toEqual({ storage: "es-ES", cookie: true });
  expect((await page.context().cookies()).map((cookie) => cookie.name).sort()).toEqual(["rv_locale_client"]);
  await page.evaluate((browserLanguageKey) => window.localStorage.setItem(browserLanguageKey, "ko-KR"), qualityBrowserLanguageKey);
  await page.reload();
  await expect(page.getByLabel("Language")).toHaveValue("es-ES");

  await page.evaluate(({ browserLanguageKey, storageKey }) => {
    window.localStorage.setItem(browserLanguageKey, "fr-FR");
    window.localStorage.setItem(storageKey, "<script>");
  }, { browserLanguageKey: qualityBrowserLanguageKey, storageKey: localeStorageKey });
  await page.reload();
  await expect(page.getByLabel("Language")).not.toHaveValue("<script>");
  await expect(page.getByLabel("Language")).toHaveValue(/^(?:en-US|zh-CN|zh-TW|ru-RU|es-ES|ja-JP|ko-KR)$/);
}

async function exerciseWorkRecordHistory(page: import("@playwright/test").Page) {
  const recordId = "round:quality-work-record";
  const summary = {
    recordId,
    strategyCode: "ai_balanced",
    strategyName: "AI 均衡策略",
    strategyVersion: "strategy-version-quality-1",
    symbol: "BTCUSDT",
    timeframe: "1h",
    decisionStatus: "hold",
    completeness: "complete",
    executionMode: "paper",
    admissionStatus: "not_required",
    hasOrderIntent: false,
    hasFillReceipt: false,
    occurredAt: "2026-08-24T12:00:00.000Z",
    isSharedDecision: true,
  };
  const stages = [
    ["market_analysis", "市场分析师", "行情与数据质量报告"],
    ["technical_analysis", "技术分析师", "技术信号报告"],
    ["strategy_proposal", "策略研究员", "策略方案"],
    ["adversarial_review", "反方审查员", "反方审查"],
    ["risk_approval", "首席风控官", "确定性风险结论"],
    ["final_decision", "AI 决策官", "最终决策"],
    ["execution_receipt", "交易执行员", "模拟执行回执"],
  ];
  await page.route("**/api/work-records**", async route => {
    const url = new URL(route.request().url());
    const body = url.pathname === "/api/work-records"
      ? { data: [summary], page: { limit: 20, nextCursor: null } }
      : {
        ...summary,
        candleOpenAt: "2026-08-24T11:00:00.000Z",
        traceId: "trace-quality-work-record",
        sharedDecisionRoundId: recordId,
        marketSnapshot: {
          exchange: "official-public-source",
          symbol: "BTCUSDT",
          timeframe: "1h",
          dataStart: "2026-08-17T12:00:00.000Z",
          dataEnd: "2026-08-24T12:00:00.000Z",
          candleCount: 168,
          datasetSha256: "a".repeat(64),
          dataQuality: { valid: true, stale: false, gapsOrDuplicates: 0, latencyMs: 120, sourceStatus: "fresh" },
        },
        events: stages.map(([role, name, outputName], index) => ({
          sequence: index + 1,
          role,
          name,
          outputName,
          conclusion: index === 5 ? "确定性结论为本轮观望。" : `${name}已完成本阶段记录。`,
          evidence: index === 0 ? { valid: true, candleCount: 168 } : {},
          llmUsed: false,
          explanationStatus: "not_required",
          explanation: null,
          createdAt: `2026-08-24T11:0${index}:00.000Z`,
        })),
        admission: { status: "not_required", cycleId: null, cycleStatus: null, decision: null, completedAt: null },
        orderIntents: [],
        fillReceipts: [],
        realOrderRoutingEnabled: false,
      };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await exerciseResponsiveWidths(page, "/trading?tab=records", "工作记录");
  await expect(page.getByText("本卡公共决策轮", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看完整记录" }).click();
  await expect(page).toHaveURL(/\/trading\?tab=records&record=round%3Aquality-work-record$/);
  await expect(page.getByRole("heading", { level: 1, name: "工作记录详情" })).toBeVisible();
  await expect(page.getByText("这是该策略卡的公共决策轮。")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "七阶段工作记录" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "你的组合准入" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "模拟意图与成交" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "审计边界" })).toBeVisible();
  const stageRegion = page.locator('[role="region"][aria-label="七阶段工作记录"][tabindex="0"]');
  await stageRegion.focus();
  await expect(stageRegion).toBeFocused();
  await expectResponsivePage(page);
  await expectCriticalAccessibility(page);
}

async function exerciseTradingHallMeetingEvidence(page: import("@playwright/test").Page) {
  const occurredAt = "2026-08-24T12:00:00.000Z";
  const stages = [
    ["market_analysis", "市场分析师", "行情与数据质量报告", "完整 K 线与数据质量已确认", { valid: true, candleCount: 168, marketState: "trend" }],
    ["technical_analysis", "技术分析师", "技术信号报告", "DSL 指标与条件树已计算", { longEntry: true, dslExit: false, close: 64250 }],
    ["strategy_proposal", "策略研究员", "策略方案", "候选策略方案：enter_long", { action: "enter_long", reason: "趋势延续" }],
    ["adversarial_review", "反方审查员", "反方审查", "未发现阻断性运行异议", { objections: [] }],
    ["risk_approval", "首席风控官", "确定性风险结论", "确定性风控允许该结论", { rejectionReasons: [] }],
    ["final_decision", "AI 决策官", "最终决策", "AI 最终决策：允许进入模拟执行", { action: "enter_long", riskApproved: true }],
    ["execution_receipt", "交易执行员", "模拟执行回执", "已生成影子/模拟订单意图", {
      executionMode: "paper",
      orderIntent: {
        mode: "paper",
        action: "enter_long",
        side: "long",
        executionTiming: "next_open",
        requestedPrice: 64260,
      },
    }],
  ];

  await page.route("**/api/trading-hall", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      productBoundary: {
        targetMarket: "spot_usdt",
        symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        leverageEnabled: false,
        shortSellingEnabled: false,
        realOrderRoutingEnabled: false,
        localExchangeExecutionEnabled: false,
        currentExecutionMode: "paper",
        alignmentStatus: "simulation_only",
      },
      strategies: [],
      agents: stages.map(([role, name, outputName, conclusion, evidence], index) => ({
        key: role,
        sequence: index + 1,
        name,
        question: `${name}问题`,
        outputName,
        status: "reported",
        latestConclusion: conclusion,
        latestUpdatedAt: occurredAt,
        latestDecisionRoundId: "round:meeting-quality",
        latestSharedDecisionRoundId: "shared:meeting-quality",
        latestStrategyName: "AI 平衡型",
        latestSymbol: "BTCUSDT",
        latestDecisionStatus: "paper_filled",
        latestCompleteness: "complete",
        latestExplanationStatus: index === 0 ? "completed" : "not_required",
        latestExplanation: index === 0 ? "市场状态解释已记录。" : null,
        latestEvidence: evidence,
        llmUsed: index === 0,
      })),
      decisionRounds: [{
        decisionRoundId: "round:meeting-quality",
        strategyCode: "ai_balanced",
        strategyName: "AI 平衡型",
        strategyVersion: "strategy-version-quality-1",
        symbol: "BTCUSDT",
        status: "paper_filled",
        executionMode: "paper",
        completeness: "complete",
        traceId: "trace-quality-meeting",
        updatedAt: occurredAt,
        paperExecution: {
          orderIntentCount: 1,
          fillReceiptCount: 1,
          latestIntentAt: occurredAt,
          latestFillAt: occurredAt,
        },
        sharedDecisionRoundId: "shared:meeting-quality",
        events: stages.map(([role, name, outputName, conclusion, evidence], index) => ({
          sequence: index + 1,
          role,
          name,
          outputName,
          conclusion,
          evidence,
          llmUsed: index === 0,
          explanationStatus: index === 0 ? "completed" : "not_required",
          explanation: index === 0 ? "市场状态解释已记录。" : null,
          createdAt: `2026-08-24T11:0${index}:00.000Z`,
        })),
      }],
      legacyAuditRecords: 0,
      generatedAt: occurredAt,
    }),
  }));

  await page.route("**/api/trading-hall/paper/platform-demo-summary", async route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      customerImpact: false,
      demoFailureAffectsPaper: false,
      providers: [{
        provider: "OKX",
        environment: "OKX_DEMO",
        status: "VERIFIED",
        lastTestedAt: occurredAt,
        cards: [
          { strategyCode: "ai_conservative", status: "NOT_TESTED", lastTestedAt: null, receiptSummary: null },
          { strategyCode: "ai_balanced", status: "FILLED", lastTestedAt: occurredAt, receiptSummary: { status: "FILLED", observedAt: occurredAt } },
          { strategyCode: "ai_aggressive", status: "NOT_TESTED", lastTestedAt: null, receiptSummary: null },
        ],
      }, {
        provider: "BINANCE",
        environment: "BINANCE_SPOT_TESTNET",
        status: "UNVERIFIED",
        lastTestedAt: occurredAt,
        cards: [
          { strategyCode: "ai_conservative", status: "NOT_TESTED", lastTestedAt: null, receiptSummary: null },
          { strategyCode: "ai_balanced", status: "RECONCILE_WAIT", lastTestedAt: occurredAt, receiptSummary: null },
          { strategyCode: "ai_aggressive", status: "NOT_TESTED", lastTestedAt: null, receiptSummary: null },
        ],
      }, {
        provider: "BYBIT",
        environment: "BYBIT_DEMO",
        status: "PAUSED",
        lastTestedAt: occurredAt,
        cards: [
          { strategyCode: "ai_conservative", status: "PAUSED", lastTestedAt: occurredAt, receiptSummary: null },
          { strategyCode: "ai_balanced", status: "PAUSED", lastTestedAt: occurredAt, receiptSummary: null },
          { strategyCode: "ai_aggressive", status: "PAUSED", lastTestedAt: occurredAt, receiptSummary: null },
        ],
      }],
    }),
  }));

  await exerciseResponsiveWidths(page, "/trading?tab=hall&view=meeting", "AI 决策会议室");
  await expect(page.getByRole("heading", { level: 2, name: "本轮摘要" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "七阶段公开记录" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "第七阶段执行证据" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "独立 Demo 证据" })).toBeVisible();
  await expect(page.getByText("这是该策略卡的公共决策轮，订阅同一策略卡的客户看到相同七阶段结论；客户私有数据只在 Paper 准入与成交侧生成。")).toBeVisible();
  await expect(page.getByText("Paper 订单意图", { exact: true })).toBeVisible();
  await expect(page.getByText("测试账户已成交", { exact: true })).toHaveCount(2);
  await expect(page.getByText("等待回执核对", { exact: true })).toBeVisible();
  await expect(page.getByText("Paper 成交来自客户模拟组合；平台 Demo 只验证测试环境，不回滚也不改写客户 Paper 结果。")).toBeVisible();
  await expectCriticalAccessibility(page);
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

test("public locale and client communication workspaces are responsive, accessible and audience-isolated", async ({ browser, page }) => {
  const anonymous = await createIsolatedQualityBrowser(browser, "client");
  try {
    await exercisePublicLocalePreference(anonymous.page);
  } finally {
    await anonymous.close();
  }
  for (const [path, heading] of [
    ["/notifications", "通知"],
    ["/account/security", "登录与设备安全"],
    ["/settings?tab=profile", "个人资料"],
    ["/settings?tab=appearance", "外观与语言"],
    ["/settings?tab=notifications", "通知偏好"],
    ["/support", "帮助与支持"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
  await exerciseAssistantCancellationWithoutDialog(page);
  await expectAudienceNavigation(page, "client");
});

test("client wallet boundaries are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/wallet", "钱包"],
    ["/wallet/deposits", "充值"],
    ["/account-center?tab=wallet", "钱包"],
    ["/account-center?tab=deposit", "充值"],
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
  await exerciseResponsiveWidths(page, "/dashboard", "数据看板");
  const emptyPortfolio = page.getByRole("heading", { level: 2, name: "尚无模拟组合" });
  if (await emptyPortfolio.isVisible().catch(() => false)) {
    await expect(page.getByText("会员权益生效后，服务端会创建对应的官方策略组合。", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByText("组合总权益", { exact: true })).toBeVisible();
    await expect(page.getByText("需关注组合", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "策略状态与最近活动" })).toBeVisible();
    await expect(page.getByText(/数据来源：模拟组合/)).toBeVisible();
  }
  await expectAudienceNavigation(page, "client");
  for (const [path, heading] of [
    // ADR-0017：`/` 只属于公开着陆页；登录后的稳定数据看板是 `/dashboard`。
    ["/trading", "交易大厅"],
    ["/trading?tab=portfolios", "模拟组合"],
    ["/strategies", "策略中心"],
    ["/strategies?tab=backtests", "策略中心"],
    ["/account-center", "会员"],
    ["/settings", "个人资料"],
    ["/membership", "会员"],
    ["/membership/orders", "会员"],
    ["/credits", "AI 积分"],
    ["/paper", "模拟组合"],
    ["/trading-hall", "交易大厅"],
    ["/work-records", "工作记录"],
    ["/performance-statements", "绩效账单"],
    ["/legal/consent", "商业披露与版本确认"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
  await exerciseWorkRecordHistory(page);
  await exerciseTradingHallMeetingEvidence(page);
  await expectAudienceNavigation(page, "client");
});
