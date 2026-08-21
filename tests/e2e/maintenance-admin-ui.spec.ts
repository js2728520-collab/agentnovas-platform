import { exerciseResponsiveWidths, test } from "./support/quality-test";

test("maintenance health workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/health", /系统(概览|健康)/);
});

test("maintenance models workspace is responsive, accessible and quiet", async ({ page }) => {
  await exerciseResponsiveWidths(page, "/models", "模型与 Agent");
});
