import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OFFICIAL_CARD_STRATEGY_CODES } from "../packages/contracts/src/market-provider-registry.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("面板明说官方卡不跟随偏好", async () => {
  const panel = await read("apps/client/ui/market-source-preference.tsx");
  // 这是这个面板最容易造成的误解：客户改了偏好，以为官方卡的数据来源也换了。
  // 说明必须是常驻的一段，不是保存后才出现的提示。
  assert.match(panel, /官方策略卡不跟随此设置/);
  assert.match(panel, /officialCards && !officialCards\.followsPreference/);
  assert.match(panel, /作用于行情展示与策略研发取数/);
});

test("「已选择」与「平台默认」不合并显示", async () => {
  const panel = await read("apps/client/ui/market-source-preference.tsx");
  // 把默认值显示成当前选择，客户就无从知道自己到底选没选过（INV-6 的同一类错误）。
  assert.match(panel, /market\.origin === "customer_preference" \? "已选择" : "平台默认"/);
  const styles = await read("apps/client/ui/market-source-preference.module.css");
  assert.match(styles, /\.origin\[data-origin="customer_preference"\]/, "两种来源必须有视觉区分");
});

test("保存失败时不改本地选择", async () => {
  const panel = await read("apps/client/ui/market-source-preference.tsx");
  const save = panel.slice(panel.indexOf("async function choose"), panel.indexOf("return <section"));
  const catchBlock = save.slice(save.indexOf("} catch (error) {"));
  // 显示一个没有落库的选择，比直接报错更糟：客户以为换了源，实际没换。
  assert.ok(!catchBlock.includes("setMarkets("), "catch 分支不得改写本地选择");
  assert.match(catchBlock, /原设置保持不变/);
});

test("面板挂在行情页上，且走的是新接口", async () => {
  const market = await read("apps/client/ui/live-market.tsx");
  assert.match(market, /import MarketSourcePreference from "\.\/market-source-preference"/);
  assert.match(market, /<MarketSourcePreference \/>/);

  const panel = await read("apps/client/ui/market-source-preference.tsx");
  assert.match(panel, /"\/api\/market\/source-preference"/);
});

test("接口响应携带官方卡事实，界面无需自己编", async () => {
  const route = await read("app/api/market/source-preference/route.client.ts");
  // 界面若自己硬编码这三个代码，改动官方卡集合时两边会错开。事实由服务端给。
  assert.match(route, /followsPreference: false/);
  assert.match(route, /strategyCodes: \[\.\.\.OFFICIAL_CARD_STRATEGY_CODES\]/);
  assert.match(route, /appliesTo: \["display", "research"\]/);

  const panel = await read("apps/client/ui/market-source-preference.tsx");
  for (const code of OFFICIAL_CARD_STRATEGY_CODES) {
    assert.ok(!panel.includes(code), `界面不得硬编码官方卡代码 ${code}`);
  }
});
