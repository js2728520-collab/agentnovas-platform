import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the server entry dispatches the Riverton shell without relying on generated output", async () => {
  const [page, dispatcher, clientRoot, client] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/riverton-route.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/audience/client-root.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /^"use client";/);
  assert.match(page, /resolveAppAudienceStrict/);
  assert.match(dispatcher, /CurrentApp/);
  assert.doesNotMatch(dispatcher, /ClientApp/);
  assert.match(clientRoot, /client-workspace-root/);
  assert.match(clientRoot, /client-portal-root/);
  assert.match(client, /交易大厅|Trading Hall/i);
  assert.match(client, /Riverton Capital/);
});

test("keeps the Riverton Capital shell and core modules present", async () => {
  const [css, page, layout, metadata, packageJson] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/riverton-metadata.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.feature-split/);
  assert.match(css, /\.risk-check-grid/);
  assert.match(page, /LiveMarket/);
  assert.match(page, /TradingCenterV2/);
  assert.match(page, /MembershipCenter/);
  assert.doesNotMatch(page, /ConnectLive|CommunityStrategyCenter|StrategyDetail/);
  assert.doesNotMatch(page, /function Admin\(/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /rivertonMetadata/);
  assert.match(metadata, /Riverton Capital 客户端/);
  assert.match(metadata, /robots:/);
  assert.match(packageJson, /"build"/);
});
