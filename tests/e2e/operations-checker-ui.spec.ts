import { exerciseResponsiveWidths, expectAudienceNavigation, test } from "./support/quality-test";

test("checker overview and approval queue are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/", "运营概览"],
    ["/approvals", "审批中心"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "operations");
  }
});
