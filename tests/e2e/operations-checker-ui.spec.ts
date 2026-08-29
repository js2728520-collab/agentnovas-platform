import { exerciseResponsiveWidths, expect, expectAudienceNavigation, test } from "./support/quality-test";
import { readQualityRuntime } from "./support/runtime";

test("checker overview and approval queue are responsive, accessible and audience-isolated", async ({ page }) => {
  for (const [path, heading] of [
    ["/", "运营看板"],
    ["/approvals", "审批中心"],
    ["/governance?tab=approvals", "审批中心"],
  ] as const) {
    await exerciseResponsiveWidths(page, path, heading);
    await expectAudienceNavigation(page, "operations");
  }
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("权限范围内客户", { exact: true })).toBeVisible();
  await expect(page.getByText(/数据来源：客户$/)).toBeVisible();
  await expect(page.getByText("累计充值入账", { exact: true })).toHaveCount(0);
  await expect(page.getByText("待资金审批", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "需要关注" })).toHaveCount(0);
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
