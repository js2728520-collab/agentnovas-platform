import { exerciseResponsiveWidths, test } from "./support/quality-test";

test("maker customer workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/customers", "客户管理");
});

test("maker membership order workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/membership-orders", "会员订单");
});
