import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Client dashboard reports customer assets, return, risk, strategy state and observation time", async () => {
  const workspace = await read("apps/client/ui/client-home-workspace.tsx");
  const model = await read("apps/client/ui/client-home-model.ts");
  assert.match(workspace, /<h1>\{t\("数据看板"\)\}<\/h1>/);
  assert.match(workspace, /组合总权益/);
  assert.match(workspace, /累计收益/);
  assert.match(workspace, /需关注组合/);
  assert.match(workspace, /策略状态与最近活动/);
  assert.match(workspace, /数据来源：模拟组合/);
  assert.match(workspace, /latestUpdatedAt/);
  assert.match(model, /attentionPortfolioCount/);
  assert.match(model, /latestUpdatedAt/);
  assert.doesNotMatch(workspace, /会员申请|AI 积分|常用工具|快捷入口/);
});

test("Operations dashboard covers scoped customer, finance, approvals, trading and risk facts", async () => {
  const workspace = await read("apps/operations/ui/operations-overview.tsx");
  const app = await read("apps/operations/ui/operations-app.tsx");
  assert.match(workspace, /title=\{t\("运营看板"\)\}/);
  assert.match(workspace, /\/api\/operations\/customers\?limit=1/);
  assert.match(workspace, /\/api\/operations\/deposits\/statistics/);
  assert.match(workspace, /\/api\/operations\/deposit-action-requests/);
  assert.match(workspace, /\/api\/operations\/kill-switches\?active=true/);
  assert.match(workspace, /\/api\/operations\/live-routing/);
  assert.match(workspace, /本次读取/);
  assert.match(workspace, /数据来源/);
  assert.match(workspace, /生效中的熔断/);
  assert.match(workspace, /实盘安全闸门/);
  assert.match(workspace, /实盘安全阻断项/);
  assert.match(workspace, /canViewAttention &&/);
  assert.match(app, /canViewTrading=/);
  assert.doesNotMatch(workspace, /不可变账本查询|付款与结算流程/);
});

test("Maintenance system overview separates runtime evidence from integration configuration", async () => {
  const workspace = await read("apps/maintenance/ui/system-overview-workspace.tsx");
  const app = await read("apps/maintenance/ui/maintenance-app.tsx");
  const healthRoute = await read("app/api/maintenance/payment-workers/health/route.maintenance.ts");
  assert.match(workspace, /title=\{t\("系统运行"\)\}/);
  assert.match(workspace, /\/api\/health/);
  assert.match(workspace, /\/api\/maintenance\/payment-workers\/health/);
  assert.match(workspace, /\/api\/maintenance\/readiness/);
  assert.match(workspace, /\/api\/maintenance\/audit\?status=failed&limit=5/);
  assert.match(workspace, /当前版本/);
  assert.match(workspace, /失败任务/);
  assert.match(workspace, /安全与技术失败事件/);
  assert.doesNotMatch(workspace, /邮件服务|优盾|支付配置|apiKeyPresent|hasSecret/);
  assert.equal((workspace.match(/className="rc-button"/g) ?? []).length, 1);
  assert.match(app, /SystemOverviewWorkspace/);
  assert.match(app, /canViewAudit=/);
  assert.match(healthRoute, /release:\s*\{/);
  assert.match(healthRoute, /RIVERTON_RELEASE_TAG/);
});
