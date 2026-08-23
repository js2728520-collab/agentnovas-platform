import { exerciseResponsiveWidths, expectAudienceNavigation, test } from "./support/quality-test";

test("client communication and account workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/notifications", "通知中心"],
    ["/account/security", "账号与登录安全"],
    ["/support", "支持与公告"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
});

test("client wallet boundaries are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/wallet", "钱包与账本"],
    ["/wallet/deposits", "USDT 充值与订单"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
});

test("client commercial and paper workspaces are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    // ADR-0017：`/` 只属于公开着陆页，不渲染客户工作台；登录后的稳定总览是 `/dashboard`。
    // 这条用例原来指向 `/` 并断言「客户工作台」——那个路由现在返回营销页，
    // 而那个标题在客户端 UI 里也已经不存在（首页 h1 是个人化问候）。
    ["/dashboard", "欢迎回来"],
    ["/membership", "会员与 AI 积分"],
    ["/membership/orders", "会员与 AI 积分"],
    ["/credits", "AI 积分"],
    ["/paper", "交易中心"],
    // /paper 是「交易中心」，/trading-hall 是「交易大厅」——两个页面两个标题，
    // 原来两条都写成「交易中心」。
    ["/trading-hall", "交易大厅"],
    ["/performance-statements", "绩效账单"],
    ["/legal/consent", "商业披露与版本确认"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "client");
  }
});
