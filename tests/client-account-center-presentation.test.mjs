import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  depositFundsLabel,
  depositOrderLabel,
  depositRiskLabel,
  legalDocumentLabel,
  ledgerEntryLabel,
  membershipPlanLabel,
  strategyLabel,
} from "../apps/client/ui/client-account-presentation.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("account center translates commercial and wallet codes into customer language", () => {
  assert.equal(membershipPlanLabel("monthly_v1"), "月卡");
  assert.equal(membershipPlanLabel("trial_monthly_equivalent"), "试用会员");
  assert.equal(legalDocumentLabel("simulated_performance_fee_opinion"), "模拟绩效服务费说明");
  assert.equal(strategyLabel("ai_conservative"), "AI 稳健型");
  assert.deepEqual(ledgerEntryLabel("membership_purchase"), {
    title: "会员服务支付",
    detail: "使用账户余额购买会员服务",
  });
  assert.deepEqual(ledgerEntryLabel("future_internal_type"), {
    title: "账户调整",
    detail: "账户余额发生变动",
  });
});

test("deposit status labels cover customer-visible order, funds and risk states", () => {
  assert.equal(depositOrderLabel("PENDING_CONFIRMATION"), "等待到账");
  assert.equal(depositOrderLabel("MANUAL_REVIEW"), "入账复核中");
  assert.equal(depositOrderLabel("CREDITED"), "已入账");
  assert.equal(depositFundsLabel("NOT_CREDITED"), "尚未入账");
  assert.equal(depositFundsLabel("AVAILABLE"), "余额可用");
  assert.equal(depositRiskLabel("PASS"), "正常");
  assert.equal(depositRiskLabel("BLOCK"), "暂不可用");
});

test("account workspaces do not render internal identifiers or duplicate account tabs", async () => {
  const membership = await read("apps/client/ui/membership-experience.tsx");
  const credits = await read("apps/client/ui/credit-workspace.tsx");
  const wallet = await read("apps/client/ui/wallet-workspace.tsx");
  const deposits = await read("apps/client/ui/deposit-workspace.tsx");

  assert.doesNotMatch(membership, /\/api\/credits\/me|creditError|contentSha256|账本版本|会员与 AI 积分/);
  assert.match(membership, /legalDocumentLabel/);
  assert.doesNotMatch(credits, /usage|版本 \$\{|IMMUTABLE CREDIT ACCOUNT|Beta/);
  assert.match(wallet, /ledgerEntryLabel/);
  assert.doesNotMatch(wallet, /entry\.sourceId|entry\.sourceType|版本 \{balance\.version\}/);
  assert.match(deposits, /depositOrderLabel|depositFundsLabel|depositRiskLabel/);
  assert.doesNotMatch(deposits, /value=\{active\.orderStatus\}|\{active\.fundsStatus\}|\{active\.riskStatus\}/);
});
