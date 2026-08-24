import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("page routing contract accepts only the stable routes owned by each audience", async () => {
  const { isRivertonPagePath } = await import("../app/riverton-route-contract.ts");

  for (const audience of ["client", "operations", "maintenance"]) {
    assert.equal(isRivertonPagePath(audience, "/"), true);
    assert.equal(isRivertonPagePath(audience, "/_not-found"), true);
    assert.equal(isRivertonPagePath(audience, "/login"), true);
    assert.equal(isRivertonPagePath(audience, "/reset-password"), true);
    assert.equal(isRivertonPagePath(audience, "/not-a-stable-route"), false);
    assert.equal(isRivertonPagePath(audience, "/setup"), false);
  }

  // /workspace 已在 P4 退役，四个界面各自成了真实路由。
  assert.equal(isRivertonPagePath("client", "/workspace"), false);
  assert.equal(isRivertonPagePath("client", "/market"), true);
  assert.equal(isRivertonPagePath("client", "/assistant"), true);
  assert.equal(isRivertonPagePath("client", "/studio"), true);
  assert.equal(isRivertonPagePath("client", "/trading-hall"), true);
  assert.equal(isRivertonPagePath("client", "/trading-hall/meeting"), true);
  assert.equal(isRivertonPagePath("client", "/trading-hall/other"), false);
  assert.equal(isRivertonPagePath("client", "/dashboard"), true);
  assert.equal(isRivertonPagePath("client", "/legal/consent"), true);
  assert.equal(isRivertonPagePath("client", "/membership/orders"), true);
  assert.equal(isRivertonPagePath("client", "/paper/portfolio-1"), true);
  assert.equal(isRivertonPagePath("client", "/verify-email"), true);
  assert.equal(isRivertonPagePath("client", "/customers"), false);
  assert.equal(isRivertonPagePath("client", "/membership/orders/extra"), false);

  assert.equal(isRivertonPagePath("operations", "/customers"), true);
  assert.equal(isRivertonPagePath("operations", "/deposits/deposit-1"), true);
  assert.equal(isRivertonPagePath("operations", "/access/audit"), true);
  assert.equal(isRivertonPagePath("operations", "/membership-orders/order-1"), true);
  assert.equal(isRivertonPagePath("operations", "/workspace"), false);
  assert.equal(isRivertonPagePath("operations", "/legal/consent"), false);
  assert.equal(isRivertonPagePath("operations", "/models"), false);
  assert.equal(isRivertonPagePath("operations", "/verify-email"), false);

  assert.equal(isRivertonPagePath("maintenance", "/models"), true);
  assert.equal(isRivertonPagePath("maintenance", "/integrations/demo-exchanges"), true);
  assert.equal(isRivertonPagePath("maintenance", "/integrations/sources"), true);
  assert.equal(isRivertonPagePath("maintenance", "/settings/disclosures"), true);
  assert.equal(isRivertonPagePath("maintenance", "/access/audit"), true);
  assert.equal(isRivertonPagePath("maintenance", "/audit"), true);
  assert.equal(isRivertonPagePath("maintenance", "/workspace"), false);
  assert.equal(isRivertonPagePath("maintenance", "/legal/consent"), false);
  assert.equal(isRivertonPagePath("maintenance", "/customers"), false);
  assert.equal(isRivertonPagePath("maintenance", "/integrations/email/extra"), false);
  assert.equal(isRivertonPagePath("operations", "/settings/disclosures"), false);
});

test("Proxy rejects invalid page routes before App Router can stream a soft 404", async () => {
  const source = await read("proxy.ts");
  assert.match(source, /isRivertonPagePath/);
  assert.match(source, /if \(!isRivertonPagePath\(audience, request\.nextUrl\.pathname\)\)/);
  assert.match(source, /destination\.pathname = "\/_not-found"/);
  assert.match(source, /NextResponse\.rewrite\(destination/);
  assert.match(source, /status:\s*404/);
});

test("每条 Client 白名单路由都必须在分发里有分支——白名单与分发是两份真源", async () => {
  // 服务端白名单（riverton-route-contract.ts）与 client-portal.tsx 的 if/else 分发是两份
  // 真源。只加白名单不加分支不会报错，请求会静默落到兜底的「资产与账本」——用户点
  // 导航看到的是钱包页而不是 404，这种错误在浏览器里很难认出来。
  const contract = await read("app/riverton-route-contract.ts");
  const dispatcher = await read("apps/client/ui/client-portal.tsx");

  const clientRoutes = contract.match(/const CLIENT_ROUTES = new Set\(\[([^\]]+)\]\)/)?.[1];
  assert.ok(clientRoutes, "未能从路由合同中解析 CLIENT_ROUTES");
  const roots = [...clientRoutes.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
  assert.ok(roots.length >= 15, `解析到的 Client 路由过少：${roots.length}`);

  // 两个刻意的例外，都在 portal 之外解决，不是遗漏：
  // - login 由 client-portal-root.tsx 在进入 portal 之前分流到 AppLogin；
  // - wallet 是 portal 末尾刻意的兜底分支。
  const dispatchedElsewhere = new Set(["login", "wallet"]);
  const portalRoot = await read("app/audience/client-portal-root.tsx");
  assert.match(portalRoot, /segments\[0\] === "login"/, "login 必须在 portal 之前分流");
  assert.match(dispatcher, /return <WalletWorkspace \/>;/, "wallet 仍是刻意兜底分支");

  for (const root of roots) {
    if (dispatchedElsewhere.has(root)) continue;
    assert.ok(
      dispatcher.includes(`route === "${root}"`),
      `路由 "${root}" 在白名单里但 client-portal.tsx 没有分支，会静默落到兜底的钱包页`,
    );
  }
});

test("工作记录是稳定路由，列表与详情各一层", async () => {
  const { isRivertonPagePath } = await import("../app/riverton-route-contract.ts");
  assert.equal(isRivertonPagePath("client", "/work-records"), true);
  assert.equal(isRivertonPagePath("client", "/work-records/round-1"), true);
  // 再深一层不是合同的一部分，必须 404 而不是落到详情页。
  assert.equal(isRivertonPagePath("client", "/work-records/round-1/extra"), false);
  // Operations 不提供工作记录页面：客户历史决策不在运营端的职责范围内。
  assert.equal(isRivertonPagePath("operations", "/work-records"), false);
  // Maintenance 有的是受控导出页，**不是**逐条详情页。运维端只能拿脱敏投影，
  // 让它能打开 /work-records/:id 就等于给了它逐条查看客户决策的入口。
  assert.equal(isRivertonPagePath("maintenance", "/work-records"), true);
  assert.equal(isRivertonPagePath("maintenance", "/work-records/round-1"), false);
});
