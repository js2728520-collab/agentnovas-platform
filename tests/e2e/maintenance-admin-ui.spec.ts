import { exerciseResponsiveWidths, test } from "./support/quality-test";

test("maintenance health workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/health", /系统(概览|健康)/);
});
