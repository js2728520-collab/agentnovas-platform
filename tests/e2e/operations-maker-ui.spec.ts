import { exerciseResponsiveWidths, expect, expectAudienceNavigation, test } from "./support/quality-test";

test("maker customer and finance read workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/", "运营看板");
  await expect(page.getByText("权限范围内客户", { exact: true })).toBeVisible();
  await expect(page.getByText("累计充值入账", { exact: true })).toBeVisible();
  await expect(page.getByText(/数据来源：客户、充值/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "需要关注" })).toBeVisible();
  await expectAudienceNavigation(page, "operations");
  for (const [path, heading] of [
    ["/customers", "客户管理"],
    ["/accounts", "运营账号"],
    ["/deposits", "充值订单"],
    ["/ledger", "账本查询"],
    ["/finance", "商业财务"],
    ["/commercial?tab=finance", "商业财务"],
    ["/governance?tab=operators", "运营账号"],
    ["/settings?tab=appearance", "外观与语言"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "operations");
  }
});

test("maker commercial queues are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/membership-orders", "会员订单"],
    ["/performance-statements", "周分成账单"],
    ["/credits", "客户 Credits"],
    ["/commercial?tab=membership", "会员订单"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "operations");
  }
});

test("maker without customer PII grants stays masked in the customer workspace", async ({ page }) => {
  await page.goto("/customers", { waitUntil: "networkidle" });
  await page.getByText(/当前角色没有客户敏感字段权限/).waitFor();
  await page.getByRole("button", { name: "临时展示所选字段" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "导出当前筛选 CSV" }).waitFor({ state: "detached" });
});
