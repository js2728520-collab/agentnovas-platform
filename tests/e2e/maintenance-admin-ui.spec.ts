import { exerciseResponsiveWidths, expect, expectAudienceNavigation, test } from "./support/quality-test";

test("maintenance health and audit workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/", "系统概览"],
    ["/health", "系统健康"],
    ["/audit", "技术审计"],
    ["/releases", "版本发布"],
    ["/configurations", "配置发布"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "maintenance");
  }
});

test("maintenance model and integration workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/models", "模型与 Agent"],
    ["/integrations", "服务集成"],
    ["/integrations/email", "邮件服务"],
    ["/integrations/payments", "优盾充值通道"],
    ["/integrations/demo-exchanges", "平台 Demo 交易所"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "maintenance");
  }
});

test("maintenance configuration and controls submit inline without confirmation dialogs", async ({ page }) => {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const save = page.getByRole("button", { name: "保存设置" });
  await expect(save).toBeDisabled();
  await page.getByLabel("设置变更原因").fill("日常平台配置维护");
  await expect(save).toBeEnabled();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/maintenance/platform-settings") && response.request().method() === "PUT");
  await save.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await saved).status()).toBe(200);
  await expect(page.getByText("平台公开设置已保存并记录审计", { exact: true })).toBeVisible();

  await page.goto("/access", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("角色配置原因")).toBeVisible();
  await page.getByLabel("角色代码").fill("quality_inline_role");
  await page.getByLabel("角色名称").fill("浏览器内联配置角色");
  await page.getByRole("checkbox", { name: /查看系统健康/ }).check();
  await page.getByLabel("角色配置原因").fill("浏览器验证权限配置无需二次弹窗");
  const createRole = page.waitForResponse((response) => response.url().endsWith("/api/access/roles") && response.request().method() === "POST");
  const publishRole = page.waitForResponse((response) => response.url().includes("/api/access/roles/") && response.url().endsWith("/publish") && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await createRole).status()).toBe(201);
  expect((await publishRole).status()).toBe(200);
  await expect(page.getByText("普通角色已创建并发布。", { exact: true })).toBeVisible();

  await page.goto("/configurations", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("作用端")).toHaveValue("client");
  await expect(page.getByLabel("作用端")).toBeDisabled();
  await expect(page.getByLabel("配置 key")).toHaveValue("client.strategy_research");
  await expect(page.getByLabel("配置 key")).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("Schema 版本")).toHaveValue("1");
  await expect(page.getByLabel("模块状态")).toHaveValue("disabled");
  await page.getByLabel("发布范围").selectOption("targeted");
  await expect(page.getByLabel("Schema 版本")).toHaveValue("2");
  await expect(page.getByLabel("模块状态")).toHaveCount(0);
  await page.getByLabel("灰度百分比").fill("25");
  await page.getByLabel("草稿创建原因").fill("发布工作台普通草稿浏览器验证");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/maintenance/configuration-versions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "直接创建草稿" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  expect(createdResponse.request().postDataJSON()).toEqual({
    kind: "feature_flag",
    key: "client.strategy_research",
    audience: "client",
    schemaVersion: 2,
    payload: {
      defaultEnabled: false,
      target: { enabled: true, rolloutPercentage: 25 },
    },
    reason: "发布工作台普通草稿浏览器验证",
  });
  await expect(page.getByText("不可变配置草稿已创建；后续修改需要创建新版本。", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("确定性测试原因").fill("浏览器触发服务端功能开关确定性测试");
  const tested = page.waitForResponse((response) => response.url().endsWith("/tests") && response.request().method() === "POST");
  await page.getByRole("button", { name: "运行确定性测试" }).click();
  const testedResponse = await tested;
  expect(testedResponse.status()).toBe(201);
  expect(testedResponse.request().postDataJSON()).toEqual({ reason: "浏览器触发服务端功能开关确定性测试" });
  await expect(page.getByText("服务端确定性测试已通过，结果与证据已绑定到该不可变 payload。", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  for (const [path, reasonLabel] of [
    ["/models", "配置与测试原因"],
    ["/integrations/email", "测试原因"],
    ["/integrations/sources", "本轮测试原因"],
    ["/integrations/payments", "配置与测试原因"],
    ["/integrations/demo-exchanges", "连接验证原因"],
    ["/settings/disclosures", "提交原因"],
    ["/releases", "版本操作原因"],
    ["/safety", "审批或事故原因"],
  ] as const) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel(reasonLabel)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }

  await page.goto("/safety", { waitUntil: "domcontentloaded" });
  const pause = page.getByRole("button", { name: "暂停官方 Paper 新开仓" });
  const resume = page.getByRole("button", { name: "解除紧急暂停" });
  const initiallyPaused = await resume.isVisible().catch(() => false);
  await page.getByLabel("审批或事故原因").fill("浏览器验证内联紧急控制流程");
  const firstResponse = page.waitForResponse((response) => response.url().endsWith("/api/maintenance/trading/emergency-stop") && response.request().method() === "POST");
  await (initiallyPaused ? resume : pause).click();
  expect((await firstResponse).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  if (!initiallyPaused) {
    await expect(resume).toBeVisible();
    await page.getByLabel("审批或事故原因").fill("浏览器验证结束后恢复初始状态");
    const restoreResponse = page.waitForResponse((response) => response.url().endsWith("/api/maintenance/trading/emergency-stop") && response.request().method() === "POST");
    await resume.click();
    expect((await restoreResponse).status()).toBe(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});
