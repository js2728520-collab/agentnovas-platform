import { exerciseResponsiveWidths, expectAudienceNavigation, test } from "./support/quality-test";

test("maintenance health and audit workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/", "系统概览"],
    ["/health", "系统健康"],
    ["/audit", "技术审计"],
    ["/releases", "版本发布"],
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
    ["/integrations/payments", "支付服务"],
    ["/integrations/demo-exchanges", "平台 Demo 交易所"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "maintenance");
  }
});
