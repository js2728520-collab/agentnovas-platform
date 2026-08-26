import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 「余额不可提现」必须出现在客户下单前看得到的地方，以及正式条款草案里。
//
// 由来：ADR-0015 明确关掉了优盾的提现、代付、划转接口，产品上余额也定性为预付服务
// 费而非托管资产。但充值页当时只写「提现未开放」——那暗示以后会开，等于给客户一个
// 不存在的预期，而事后拒绝提现就是失信。
//
// 这类告知的价值全在「客户读到了」。被删掉或被弱化不会让任何测试变红，
// 除非有一条测试专门守着它。

const depositPage = await readFile(new URL("../apps/client/ui/deposit-workspace.tsx", import.meta.url), "utf8");
const disclosures = await readFile(
  new URL("../apps/maintenance/ui/commercial-disclosures-workspace.tsx", import.meta.url), "utf8");

test("充值页明确告知余额不可提现", () => {
  assert.match(depositPage, /不能提现/);
  assert.match(depositPage, /只能用于购买本平台服务/);
});

test("充值页不再说「未开放」", () => {
  // 「未开放」与「不可提现」是两回事：前者暗示以后会开。
  assert.equal(/提现[、，]?[^。]{0,10}未开放/.test(depositPage), false,
    "不得把永久性的产品边界写成暂缓开放");
});

test("该告知使用警示样式，不与普通提示混在一起", () => {
  // 信息色的提示条在这个界面里到处都是，客户会当成背景噪音略过。
  assert.match(depositPage, /rc-callout-warning/);
  assert.match(depositPage, /role="alert"/);
});

test("退款政策草案写明不可提现、不可转出、不可退回", () => {
  const draft = disclosures.slice(disclosures.indexOf("refund_policy:"));
  for (const phrase of ["不可提现", "不可转出", "不可退回", "充值即视为购买服务额度"]) {
    assert.ok(draft.includes(phrase), `退款政策草案缺少「${phrase}」`);
  }
});

test("服务费说明与钱包扣款的实际行为一致", () => {
  // 这条草案原本写「不从客户钱包自动扣款」，而钱包支付上线后那句话只对了一半：
  // 平台确实不会自动扣，但客户可以主动用钱包结清。描述与行为不符的披露比没有更糟。
  const draft = disclosures.slice(disclosures.indexOf("simulated_performance_fee_opinion:"));
  assert.ok(draft.includes("钱包余额支付"), "应说明客户可主动用钱包结清");
  assert.ok(draft.includes("未经客户操作的情况下自动扣款"), "应保留「不自动扣款」的承诺");
});
