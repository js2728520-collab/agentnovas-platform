import { exerciseResponsiveWidths, expectAudienceNavigation, test } from "./support/quality-test";
import { readQualityRuntime } from "./support/runtime";

test("checker overview and approval queue are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/", "运营概览"],
    ["/approvals", "审批中心"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "operations");
  }
});

test("checker reveals explicitly granted customer fields only after entering an audited reason", async ({ page }) => {
  const runtime = await readQualityRuntime();
  await page.goto("/customers", { waitUntil: "networkidle" });
  await page.getByLabel("完整联系方式").check();
  await page.getByLabel(/业务原因/).fill("处理客户授权的联系方式核对工单");
  await page.getByRole("button", { name: "临时展示所选字段" }).click();
  await page.getByText(runtime.identities.client.email, { exact: true }).first().waitFor();
  await page.getByText(/本次访问原因已记录审计/).waitFor();
  await page.getByRole("button", { name: "导出当前筛选 CSV" }).waitFor();
});
