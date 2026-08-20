import { exerciseResponsiveWidths, test } from "./support/quality-test";

test("checker operations overview is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/", "运营概览");
});
