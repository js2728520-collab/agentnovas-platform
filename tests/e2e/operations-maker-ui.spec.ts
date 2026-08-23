import { exerciseResponsiveWidths, expectAudienceNavigation, test } from "./support/quality-test";

test("maker customer and finance read workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/customers", "客户管理"],
    ["/accounts", "运营账号"],
    ["/invitations", "我的邀请链接"],
    ["/deposits", "充值订单"],
    ["/ledger", "账本查询"],
    ["/finance", "商业财务"],
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
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "operations");
  }
});
