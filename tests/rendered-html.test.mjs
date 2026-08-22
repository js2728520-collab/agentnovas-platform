import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the server entry dispatches the Riverton shell without relying on generated output", async () => {
  const [page, dispatcher, clientRoot, hall, shell] = await Promise.all([
    read("app/page.tsx"),
    read("app/riverton-route.tsx"),
    read("app/audience/client-root.tsx"),
    read("apps/client/ui/decision-hall.tsx"),
    read("apps/client/ui/client-portal-shell.tsx"),
  ]);
  assert.doesNotMatch(page, /^"use client";/);
  assert.match(page, /resolveAppAudienceStrict/);
  assert.match(dispatcher, /CurrentApp/);
  assert.doesNotMatch(dispatcher, /ClientApp/);
  // /workspace 已在 P4 退役；客户端入口只应指向门户。
  assert.doesNotMatch(clientRoot, /client-workspace-root/);
  assert.match(clientRoot, /client-portal-root/);
  assert.match(hall, /交易大厅/);
  assert.match(shell, /Riverton Capital/);
});

test("keeps the Riverton Capital shell and core modules present", async () => {
  const [css, portal, layout, metadata, packageJson] = await Promise.all([
    read("apps/client/ui/client-public-landing.module.css"),
    read("apps/client/ui/client-portal.tsx"),
    read("app/layout.tsx"),
    read("lib/riverton-metadata.ts"),
    read("package.json"),
  ]);
  // 落地页重设计后类名变了：.feature-split → .split（图文分栏）。
  // 断言的意图不变：落地页有图文分栏这一节。
  assert.match(css, /\.split \{/);
  // 核心工作区此前是遗留 SPA 里的动态导入，现在是门户的逐路由分发。
  assert.match(portal, /LiveMarket/);
  assert.match(portal, /TradingExperience/);
  assert.match(portal, /MembershipExperience/);
  assert.match(portal, /DecisionHall/);
  assert.match(portal, /StrategyStudio/);
  assert.match(portal, /AiAssistantChat/);
  // 这些是 P4 删掉的遗留界面，不得重新出现在门户里。
  assert.doesNotMatch(portal, /ConnectLive|CommunityStrategyCenter|StrategyDetail/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /rivertonMetadata/);
  assert.match(metadata, /Riverton Capital 客户端/);
  assert.match(metadata, /robots:/);
  assert.match(packageJson, /"build"/);
});
