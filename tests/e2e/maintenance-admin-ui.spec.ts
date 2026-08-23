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

test("ordinary maintenance configuration submits inline without confirmation dialogs", async ({ page }) => {
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

  await page.goto("/configurations", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("草稿创建原因").fill("发布工作台普通草稿浏览器验证");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/maintenance/configuration-versions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "直接创建草稿" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await created).status()).toBe(201);
  await expect(page.getByText("不可变配置草稿已创建；后续修改需要创建新版本。", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  for (const [path, reasonLabel] of [
    ["/models", "配置与测试原因"],
    ["/integrations/email", "测试原因"],
    ["/integrations/sources", "本轮测试原因"],
    ["/integrations/payments", "配置与测试原因"],
    ["/integrations/demo-exchanges", "连接验证原因"],
  ] as const) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel(reasonLabel)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});
