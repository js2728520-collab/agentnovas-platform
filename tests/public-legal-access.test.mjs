import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isRivertonAppRoute } from "../app/riverton-route-contract.ts";

// 条款必须对**未登录访客**可读。
//
// 由来：落地页页脚摆着「风险披露 隐私政策 服务条款」三个词，但那是纯文本——点不动，
// 也没有任何对应页面。而唯一能读到条款的接口 /api/membership/legal-consent 需要登录。
// 视觉上像入口、实际打不开，访客会认为平台把条款藏起来了。

const inventory = await readFile(new URL("../lib/api-route-inventory.ts", import.meta.url), "utf8");
const portal = await readFile(new URL("../apps/client/ui/client-portal.tsx", import.meta.url), "utf8");
const landing = await readFile(new URL("../apps/client/ui/client-public-landing.tsx", import.meta.url), "utf8");

test("公开条款接口是匿名可访问的", () => {
  const index = inventory.indexOf('"route": "/api/platform/legal"');
  assert.ok(index > 0, "接口必须登记在 inventory 里");
  const block = inventory.slice(index, index + 700);
  assert.match(block, /"authentication": "anonymous"/,
    "需要登录的条款接口等于没有对外公开条款");
});

test("/legal 与 /legal/consent 都是合法路由", () => {
  // 前者是公开条款页，后者是登录后的确认流程。
  assert.equal(isRivertonAppRoute("client", ["legal"]), true);
  assert.equal(isRivertonAppRoute("client", ["legal", "consent"]), true);
  assert.equal(isRivertonAppRoute("client", ["legal", "unknown"]), false);
});

test("公开条款页排在登录判定之前", () => {
  // 放在 `session.status !== "authenticated"` 之后的话，未登录访客仍然看不到——
  // 而页脚正是要链接到这里。
  const publicRoute = portal.indexOf('route === "legal" && !segments[1]');
  const authGate = portal.indexOf('session.status !== "authenticated"');
  assert.ok(publicRoute > 0, "找不到公开条款页的分发");
  assert.ok(publicRoute < authGate, "公开页必须排在登录判定之前");
});

test("页脚是真链接，不是纯文本", () => {
  assert.match(landing, /href="\/legal#risk_disclosure"/);
  assert.match(landing, /href="\/legal#privacy"/);
  assert.match(landing, /href="\/legal#terms"/);
});

test("全部语言的页脚标签都拆成了独立键", async () => {
  // 只拆一部分语言的话，其余语言的页脚会渲染成 undefined。
  // 这条测试第一次跑就抓到了漏网：落地页是七种语言，不是四种。
  const locales = await readFile(new URL("../apps/client/ui/client-public-landing-locales.ts", import.meta.url), "utf8");
  const risk = (locales.match(/legalRisk:/g) ?? []).length;
  assert.ok(risk >= 7, `至少七种语言，实际 ${risk}`);
  assert.equal((locales.match(/legalPrivacy:/g) ?? []).length, risk);
  assert.equal((locales.match(/legalTerms:/g) ?? []).length, risk);
  assert.equal(/^\s+legal: "/m.test(locales), false, "不应残留合并的 legal 键");
});

test("一条都没发布时说实话，而不是显示空壳页面", async () => {
  const page = await readFile(new URL("../apps/client/ui/public-legal-page.tsx", import.meta.url), "utf8");
  assert.match(page, /条款尚未发布/);
  assert.match(page, /请勿注册或充值/, "没有可确认的条款就没有可依据的服务约定");
});

test("披露未配齐时公开页返回空列表而不是 503", async () => {
  // 底层的 LEGAL_CONFIGURATION_INCOMPLETE 503 是给业务闸门用的语义（没配齐就不许
  // 下单）。对公开页面来说 503 是错的：访客该看到「条款尚未发布」，而不是一个
  // 看起来像平台故障的错误。
  const route = await readFile(new URL("../app/api/platform/legal/route.client.ts", import.meta.url), "utf8");
  assert.match(route, /LEGAL_CONFIGURATION_INCOMPLETE/);
  assert.match(route, /documents: \[\]/);
  // 但只吞这一种错误——真正的故障仍要抛出去。
  assert.match(route, /if \(code !== "LEGAL_CONFIGURATION_INCOMPLETE"\) throw error;/);
});
