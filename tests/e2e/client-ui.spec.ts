import { exerciseResponsiveWidths, test } from "./support/quality-test";

test("client notification workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/notifications", "通知中心");
});

test("client wallet workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/wallet", "钱包与账本");
});

test("client home and versioned commercial disclosure workspace are responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/", "客户工作台");
  await exerciseResponsiveWidths(page, "/legal/consent", "商业披露与版本确认");
});
