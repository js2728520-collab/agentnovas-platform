import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("三处注册齐全且懒加载", async () => {
  const [contract, portal, shell] = await Promise.all([
    read("app/riverton-route-contract.ts"),
    read("apps/client/ui/client-portal.tsx"),
    read("apps/client/ui/client-portal-shell.tsx"),
  ]);
  assert.match(contract, /"follows"/);
  assert.match(portal, /route === "follows"/);
  assert.match(shell, /href: "\/follows"/);
  assert.match(portal, /const FollowResultsWorkspace = dynamic\(/);
});

test("被风控阻断时说清是谁停的、能不能自己恢复", async () => {
  const workspace = await read("apps/client/ui/follow-results-workspace.tsx");
  // 不说清楚，客户只会看到「不开仓」，而看不出是被停了。
  assert.match(workspace, /follow\.status === "risk_blocked"/);
  assert.match(workspace, /该跟单已被\{authorityLabels/);
  assert.match(workspace, /新开仓已停止，已有持仓仍可离场/);
  assert.match(workspace, /恢复需要联系运营风控/);
  // 四方都要能显示出来。
  for (const authority of ["customer", "operations_risk", "automated_risk", "global_circuit_breaker"]) {
    assert.ok(workspace.includes(authority), `缺少权威 ${authority}`);
  }
});

test("明说模拟跟单不收分成，合同费率待实盘才适用", async () => {
  // 不说清楚，客户看到合同里的费率会以为在扣钱（P-06：paper 不收费）。
  const workspace = await read("apps/client/ui/follow-results-workspace.tsx");
  assert.match(workspace, /模拟跟单不收取绩效分成/);
  assert.match(workspace, /将在实盘跟单开放后才适用/);
  const route = await read("app/api/strategy-follows/route.client.ts");
  assert.match(route, /paperChargesFees: false/);
});

test("明说盈亏不可提取", async () => {
  const workspace = await read("apps/client/ui/follow-results-workspace.tsx");
  assert.match(workspace, /盈亏为服务器记账结果，不产生真实订单，也不可提取/);
});

test("只返回本人的跟随，不返回作者与其他跟随者", async () => {
  const route = await read("app/api/strategy-follows/route.client.ts");
  assert.match(route, /subscription\.customer_id = \$1/);
  // 多返回一个字段就多一条泄露路径。
  assert.doesNotMatch(route, /author_user_id/);
  assert.match(route, /只返回\*\*本人\*\*的跟随/);
});

test("买入行的已实现盈亏显示为空而不是 0", async () => {
  // 买入没有已实现盈亏。显示 0 会让人以为这笔交易不赚不亏。
  const workspace = await read("apps/client/ui/follow-results-workspace.tsx");
  assert.match(workspace, /fill\.action === "buy" \? "—" : money\(fill\.realizedNetPnlUsdt\)/);
});
