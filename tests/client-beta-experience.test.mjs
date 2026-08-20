import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("membership experience uses commercial truth sources and contains no simulated payment flow", async () => {
  const entry = await read("app/membership-center.tsx");
  const experience = await read("apps/client/ui/membership-experience.tsx");
  const source = `${entry}\n${experience}`;

  for (const endpoint of [
    "/api/membership/plans",
    "/api/membership/me",
    "/api/membership/orders",
    "/api/credits/me",
  ]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));

  assert.match(source, /paymentInstructionsStatus/);
  assert.match(source, /acceptedDocumentVersionIds/);
  assert.match(source, /idempotency-key/);
  assert.doesNotMatch(source, /二维码|倒计时|监听中|充值积分|积分充值|TRC20|0x[a-fA-F0-9]{8}/);
});

test("wallet is read-only and the deposit workspace is a closed Beta boundary", async () => {
  const wallet = await read("apps/client/ui/wallet-workspace.tsx");
  const deposits = await read("apps/client/ui/deposit-workspace.tsx");
  assert.match(wallet, /只读/);
  assert.doesNotMatch(wallet, /创建充值订单/);
  assert.match(deposits, /Beta/);
  assert.match(deposits, /暂不开放/);
  assert.doesNotMatch(deposits, /fetch\(|deposit-orders|method:\s*["']POST["']/);
});

test("client notification settings expose unintegrated external channels without demo verification", async () => {
  const workspace = await read("apps/client/ui/notification-workspace.tsx");
  const settings = await read("apps/client/ui/client-notification-settings.tsx");
  assert.match(workspace, /ClientNotificationSettings/);
  assert.match(settings, /not_integrated/);
  assert.match(settings, /\/api\/notifications\/preferences/);
  assert.doesNotMatch(settings, /verificationCode|演示验证码|\/api\/notifications\/channels/);
});

test("trading experience reads official paper evidence and never presents client exchange writes", async () => {
  const entry = await read("app/trading-center.tsx");
  const experience = await read("apps/client/ui/trading-experience.tsx");
  const source = `${entry}\n${experience}`;
  assert.match(source, /\/api\/trading-hall\/paper\/portfolio/);
  assert.match(source, /\/api\/trading-hall\/paper\/trades/);
  assert.match(source, /\/api\/trading-hall/);
  assert.match(source, /未提供平台验证回执/);
  assert.doesNotMatch(source, /\/api\/exchange-accounts|\/api\/portfolio|\/api\/trading\/emergency-stop/);
  assert.doesNotMatch(source, /连接交易所|API Key/);
});
