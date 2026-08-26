import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("路由白名单与分发两份真源都改了", async () => {
  // CLAUDE.md 记的陷阱：白名单与分发是两份真源，只改白名单会让请求静默落到兜底页
  // （Client 会落到「资产与账本」）。
  const contract = await read("app/riverton-route-contract.ts");
  const portal = await read("apps/client/ui/client-portal.tsx");
  assert.match(contract, /"marketplace"/);
  assert.match(portal, /route === "marketplace"/);
});

test("工作区走 next/dynamic 懒加载", async () => {
  // Client 的 JS 预算余量只有几百字节，静态 import 会把整个工作区打进公开落地页的包。
  const portal = await read("apps/client/ui/client-portal.tsx");
  assert.match(portal, /const StrategyMarketplaceWorkspace = dynamic\(\(\) => import\("\.\/strategy-marketplace-workspace"\)\)/);
});

test("披露必须勾选后才能提交", async () => {
  const workspace = await read("apps/client/ui/strategy-marketplace-workspace.tsx");
  // 默认同意等于没有确认——服务端也拒绝 acceptDisclosure !== true，两侧一致。
  assert.match(workspace, /disabled=\{busy \|\| !accepted \|\| !valid\}/);
  assert.match(workspace, /acceptDisclosure: accepted/);
  const route = await read("app/api/strategy-marketplace/[id]/follow/route.client.ts");
  assert.match(route, /body\.acceptDisclosure !== true/);
});

test("界面展示的披露与服务端固定的那份逐条一致", async () => {
  // 客户确认的摘要由服务端算。界面显示另一套文字，摘要证明的就不是客户看到的东西。
  const workspace = await read("apps/client/ui/strategy-marketplace-workspace.tsx");
  const route = await read("app/api/strategy-marketplace/[id]/follow/route.client.ts");
  const lines = [...workspace.matchAll(/^\s{2}"(.+?)",$/gm)].map((match) => match[1]);
  const disclosure = lines.filter((line) => line.includes("。"));
  assert.ok(disclosure.length >= 3, `界面披露正文解析失败：${JSON.stringify(lines)}`);
  for (const line of disclosure) {
    assert.ok(route.includes(line), `服务端披露缺少这一条：${line}`);
  }
});

test("策略广场提供品种、风险、收益筛选与排序", async () => {
  const workspace = await read("apps/client/ui/strategy-marketplace-workspace.tsx");
  assert.match(workspace, /symbolFilter/);
  assert.match(workspace, /riskFilter/);
  assert.match(workspace, /returnFilter/);
  assert.match(workspace, /sortKey/);
  assert.match(workspace, /按交易品种筛选/);
  assert.match(workspace, /按风险档筛选/);
  assert.match(workspace, /按收益区间筛选/);
  assert.match(workspace, /策略排序/);
  assert.match(workspace, /没有符合条件的策略/);
});
test("止损线说明写清它就是自动风控的停机线", async () => {
  // 客户同意的是这个数字，不是某个他没看过的平台阈值（需求方 2026-08-24 确认）。
  const workspace = await read("apps/client/ui/strategy-marketplace-workspace.tsx");
  assert.match(workspace, /累计回撤触及这条线时，系统自动阻断该跟单的新开仓/);
});

test("止盈由已确认策略版本的 exit 条件驱动，不提供额外固定目标", async () => {
  const workspace = await read("apps/client/ui/strategy-marketplace-workspace.tsx");
  const route = await read("app/api/strategy-marketplace/[id]/follow/route.client.ts");
  assert.match(workspace, /不设置单独的固定止盈线；已有持仓何时离场由你确认的策略版本中的离场条件决定/);
  assert.doesNotMatch(workspace, /name=["']takeProfitPct["']/);
  assert.match(route, /allowedFields = new Set\(\["capitalPct", "stopLossPct", "acceptDisclosure"\]\)/);
  assert.doesNotMatch(route, /body\.takeProfitPct/);
});

test("明说是模拟跟单，不产生真实订单", async () => {
  const workspace = await read("apps/client/ui/strategy-marketplace-workspace.tsx");
  assert.match(workspace, /跟单为服务器记账的模拟成交，不产生真实订单/);
  assert.match(workspace, /开启模拟跟单/);
});

test("提交失败时不改本地状态", async () => {
  const workspace = await read("apps/client/ui/strategy-marketplace-workspace.tsx");
  const follow = workspace.slice(workspace.indexOf("async function follow()"), workspace.indexOf("return <section"));
  const catchBlock = follow.slice(follow.indexOf("} catch (error) {"));
  // 显示一个没有生效的跟单，比报错更糟。
  assert.ok(!catchBlock.includes("setMessageKind(\"success\")"));
  assert.match(catchBlock, /失败时不改本地状态/);
});
