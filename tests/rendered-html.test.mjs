import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the server entry dispatches the Riverton shell without relying on generated output", async () => {
  const [page, dispatcher, client] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/riverton-route.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /^"use client";/);
  assert.match(page, /resolveAppAudience/);
  assert.match(dispatcher, /ClientApp/);
  assert.match(client, /交易大厅|Trading Hall/i);
  assert.match(client, /Riverton Capital/);
});

test("keeps the Riverton Capital shell and core modules present", async () => {
  const [css, page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/client-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.feature-split/);
  assert.match(css, /\.risk-check-grid/);
  assert.match(page, /LiveMarket/);
  assert.match(page, /ConnectLive/);
  assert.match(page, /CommunityStrategyCenter/);
  assert.match(page, /StrategyDetail/);
  assert.match(layout, /export const metadata:\s*Metadata/);
  assert.match(layout, /Riverton Capital/);
  assert.match(packageJson, /"build"/);
});
