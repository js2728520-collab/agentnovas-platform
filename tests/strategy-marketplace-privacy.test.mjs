import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { API_ROUTE_INVENTORY } from "../lib/api-route-inventory.ts";

const route = await readFile(
  new URL("../app/api/strategy-marketplace/route.client.ts", import.meta.url), "utf8");
/**
 * 去掉注释再断言。解释这个修复的注释里必然出现「authorEmail」——对注释文本做断言，
 * 会把「说明我们不返回邮箱」误判成「返回了邮箱」。
 */
const stripComments = (source) => source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const publicList = stripComments(
  route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST")));

test("公开广场不返回作者邮箱", async () => {
  // 这条曾经真的泄露过：fields 里 select 了 users.email，再被 spread 进公开响应，
  // 而广场对未登录访客开放。昵称与用户名是作者自己设定的公开标识，邮箱不是。
  assert.doesNotMatch(publicList, /users\.email/);
  assert.doesNotMatch(publicList, /authorEmail/);
});

test("公开响应逐字段列出，不 spread 整行", async () => {
  // spread 会让将来往 fields 里加的任何列自动变成公开数据——authorEmail 正是这么泄露的。
  assert.doesNotMatch(publicList, /published: published\.map\(\(row\) => \(\{\s*\n\s*\.\.\.row,/);
  assert.match(publicList, /const \{ authorRole, symbolsJson, \.\.\.rest \} = row;/);
});

test("不公开策略逻辑，只公开历史表现", async () => {
  // 需求方 2026-08-24 确认：不展示策略逻辑，不公开 DSL。公开条件树等于让人不跟单就能
  // 抄走策略，作者的投稿激励会消失。
  assert.doesNotMatch(publicList, /specificationJson: communityStrategies\.specificationJson/);
  const fields = publicList.slice(publicList.indexOf("const fields = {"), publicList.indexOf("};", publicList.indexOf("const fields = {")));
  assert.doesNotMatch(fields, /specification|conversation/i);

  const workspace = await readFile(
    new URL("../apps/client/ui/strategy-marketplace-workspace.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(workspace, /specification|entry|exit|legs/i);
  // 展示的是历史表现：跟随人数、回测收益、回撤、胜率、样本、区间。
  assert.match(workspace, /跟随人数/);
  assert.match(workspace, /回测净收益/);
  assert.match(workspace, /回测区间/);
});

test("内部角色枚举不外露，只给「是不是平台自营」", async () => {
  assert.match(publicList, /isPlatformAuthor: authorRole !== "customer"/);
  const workspace = await readFile(
    new URL("../apps/client/ui/strategy-marketplace-workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /strategy\.isPlatformAuthor \? "平台自营"/);
  assert.doesNotMatch(workspace, /hq_admin|authorRole/);
});

test("广场列表已启用且登记为匿名可读", async () => {
  // 此前它在 Beta 停用清单里，整个接口返回 503——界面调它只会看到错误。
  const entry = API_ROUTE_INVENTORY.find(
    (item) => item.route === "/api/strategy-marketplace" && item.method === "GET");
  assert.ok(entry, "广场列表未登记");
  assert.equal(entry.authentication, "anonymous");
  assert.equal(entry.pii, "none");
});
