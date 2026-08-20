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
