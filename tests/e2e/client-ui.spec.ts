import { exerciseResponsiveWidths, test } from "./support/quality-test";

test("client notification workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/notifications", "通知中心");
});
