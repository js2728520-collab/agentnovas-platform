import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AI_CREDIT_PRICING,
  BOUNDARY_CHANGES_REQUIRING_ADR,
  DEVICE_SESSION_POLICY,
  DOMAINS,
  EQUITY_MARKETS,
  EQUITY_MARKET_DATA,
  EXCHANGE_ROLLOUT_ORDER,
  FOLLOW_FEES,
  FUNDS_OUTBOUND,
  FX_METALS_SCOPE,
  LOCALE_SCOPE,
  LOGIN_LOCATION_PRECISION,
  MEMBERSHIP_PLANS,
  MEMBERSHIP_PRICING_CONTROL,
  METAMASK_INTEGRATION,
  PRODUCT_PARAMETERS_CONFIRMED_AT,
  QUANTDINGER_PORT,
  STRATEGY_ADMISSION,
  THEMES,
} from "../packages/contracts/src/product-parameters.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("P-01：八家交易所按确认顺序，MetaMask 首期不接入", () => {
  assert.deepEqual([...EXCHANGE_ROLLOUT_ORDER], [
    "binance", "okx", "coinbase", "crypto_com", "kraken", "gate_io", "bitget", "htx",
  ]);
  // 确认单在推荐五家之外追加了 gate.io、bitget、HTX。
  assert.equal(EXCHANGE_ROLLOUT_ORDER.length, 8);
  assert.equal(METAMASK_INTEGRATION.enabled, false);
  // 即使将来接入，签名与资金能力也要单独决策，不随「接入」一起打开。
  assert.equal(METAMASK_INTEGRATION.allowsOrderSigning, false);
  assert.equal(METAMASK_INTEGRATION.allowsFundsMovement, false);
});

test("P-03：六个股票市场，首期延迟 15 分钟且运维端可升级", () => {
  assert.equal(EQUITY_MARKETS.length, 6);
  // 确认单在 A 股/港股之外追加了美股、韩股、日股、澳股。
  assert.ok(EQUITY_MARKETS.includes("equities-us"));
  assert.ok(EQUITY_MARKETS.includes("equities-au"));
  assert.equal(EQUITY_MARKET_DATA.defaultMode, "delayed");
  assert.equal(EQUITY_MARKET_DATA.delayMinutes, 15);
  // 升级为实时是配置变更而不是代码变更，市场可见性同理。
  assert.equal(EQUITY_MARKET_DATA.operatorConfigurableMode, true);
  assert.equal(EQUITY_MARKET_DATA.operatorConfigurableVisibility, true);
  // 供应商未定：留 null，不把技术选型伪装成需求方结论。
  assert.equal(EQUITY_MARKET_DATA.provider, null);
});

test("P-05：不设模拟盘，回撤按风险等级分档且高于官方卡", () => {
  assert.equal(STRATEGY_ADMISSION.minimumBacktestDays, 180);
  // 取消模拟盘后，人工审核成为唯一实质门槛，因此它必须是强制的。
  assert.equal(STRATEGY_ADMISSION.requiresPaperTradingPeriod, false);
  assert.equal(STRATEGY_ADMISSION.requiresManualReview, true);
  assert.equal(STRATEGY_ADMISSION.minimumTrades, 30);
  assert.equal(STRATEGY_ADMISSION.minimumNetReturnPct, 0);
  assert.deepEqual(STRATEGY_ADMISSION.maximumDrawdownPctByTier, {
    conservative: 10, balanced: 15, aggressive: 20,
  });
  // 官方三张卡是 6/10/15。客户投稿允许更激进，这是需求方确认过的差异，
  // 不是笔误——这条断言防止有人「顺手改回」官方卡数值。
  const official = { conservative: 6, balanced: 10, aggressive: 15 };
  for (const tier of ["conservative", "balanced", "aggressive"]) {
    assert.ok(
      STRATEGY_ADMISSION.maximumDrawdownPctByTier[tier] > official[tier],
      `${tier} 档的客户策略门槛应高于官方卡，需求方已确认此差异`,
    );
  }
});

test("P-06：只收分成、五五分账，且保持高水位线", () => {
  assert.equal(FOLLOW_FEES.subscriptionFeeUsdt, "0");
  assert.equal(FOLLOW_FEES.performanceFeeRate, "0.20");
  assert.equal(FOLLOW_FEES.authorShareRate, "0.50");
  assert.equal(FOLLOW_FEES.platformShareRate, "0.50");
  assert.equal(Number(FOLLOW_FEES.authorShareRate) + Number(FOLLOW_FEES.platformShareRate), 1);
  // 确认单正文一度写成「每周清零」，需求方澄清为笔误。清零会对上周亏损后的反弹重复
  // 收费，也违反 INV-5。这条断言是那次澄清的落点。
  assert.equal(FOLLOW_FEES.settlementCycle, "utc_week");
  assert.equal(FOLLOW_FEES.highWaterMark, true);
  assert.equal(FOLLOW_FEES.settledFeesRefundable, false);
});

test("P-07：四档价格与按档递减的分成费率", () => {
  assert.deepEqual(MEMBERSHIP_PLANS.map((plan) => plan.priceUsdt), ["59", "129", "499", "1999"]);
  assert.deepEqual(MEMBERSHIP_PLANS.map((plan) => plan.performanceFeeRate), ["0.20", "0.19", "0.18", "0.16"]);
  assert.deepEqual(MEMBERSHIP_PLANS.map((plan) => plan.credits), [1_000, 3_000, 12_000, 36_000]);
  // 期限越长费率越低，这个单调性是产品意图，反了就是配置错误。
  const rates = MEMBERSHIP_PLANS.map((plan) => Number(plan.performanceFeeRate));
  for (let index = 1; index < rates.length; index += 1) {
    assert.ok(rates[index] < rates[index - 1], "分成费率必须随套餐期限递减");
  }
  // 改价是资金相关变更，运营端可调不等于可以单人改。
  assert.equal(MEMBERSHIP_PRICING_CONTROL.requiresMakerChecker, true);
});

test("P-08：默认固定扣费，同时保留用量结算", () => {
  assert.equal(AI_CREDIT_PRICING.defaultMode, "fixed");
  assert.deepEqual([...AI_CREDIT_PRICING.availableModes], ["fixed", "provider_usage"]);
  assert.equal(AI_CREDIT_PRICING.conversationCredits, 1);
  assert.equal(AI_CREDIT_PRICING.strategyGenerationCredits, 10);
  assert.equal(AI_CREDIT_PRICING.maintenanceConfigurable, true);
  assert.deepEqual(AI_CREDIT_PRICING.modelTiers.map((tier) => tier.multiplier), ["1.0", "2.0"]);
});

test("P-09：提现限定为平台服务余额，且不触碰 INV-11", () => {
  assert.equal(FUNDS_OUTBOUND.productApproved, true);
  assert.equal(FUNDS_OUTBOUND.scope, "platform_service_balance");
  // INV-11 管的是客户交易所账户的提现权限，与平台余额提现是两件事。
  // 这条断言防止范围在实现过程中被悄悄扩大。
  assert.equal(FUNDS_OUTBOUND.includesExchangeAccountWithdrawal, false);
  assert.deepEqual([...FUNDS_OUTBOUND.networks], ["usdt_trc20", "usdt_erc20", "usdt_bep20"]);
  assert.equal(FUNDS_OUTBOUND.singleLimitUsdt, "10000");
  assert.equal(FUNDS_OUTBOUND.dailyLimitUsdt, "100000");
  assert.equal(FUNDS_OUTBOUND.requiresAddressAllowlist, true);
  assert.equal(FUNDS_OUTBOUND.addressCoolingPeriodHours, 24);
  assert.equal(FUNDS_OUTBOUND.requiresMakerChecker, true);
  // 确认单写「分公司总经理权限一级」；资金变更按 INV-3 必须双人复核，
  // 因此该角色是发起权限而不是单人改价权限。
  assert.equal(FUNDS_OUTBOUND.feeChangeRequiresMakerChecker, true);
});

test("A-01：自动挤出必须伴随通知，否则是账号安全盲区", () => {
  assert.equal(DEVICE_SESSION_POLICY.maximumDevices, 5);
  assert.equal(DEVICE_SESSION_POLICY.overflowBehaviour, "evict_least_recently_used");
  // 没有通知的自动挤出，攻击者登录后可以把本人悄悄挤下线而本人只当是掉线。
  assert.equal(DEVICE_SESSION_POLICY.notifiesEvictedDevice, true);
  assert.deepEqual([...DEVICE_SESSION_POLICY.notificationChannels], ["in_app", "email"]);
});

test("A-02/A-03：不引入第三方定位；只有客户端多语言", () => {
  assert.equal(LOGIN_LOCATION_PRECISION.precision, "network_segment");
  assert.equal(LOGIN_LOCATION_PRECISION.usesThirdPartyGeolocation, false);
  assert.equal(LOGIN_LOCATION_PRECISION.usesGeolocationDatabase, false);
  assert.deepEqual([...LOCALE_SCOPE.multilingualAudiences], ["client"]);
  assert.equal(LOCALE_SCOPE.emailLocale, "en-US");
  assert.equal(LOCALE_SCOPE.supportedLocales.length, 7);
});

test("其余参数按确认单落定", () => {
  assert.equal(FX_METALS_SCOPE.tradable, false);
  assert.equal(FX_METALS_SCOPE.quotesEnabled, true);
  assert.equal(QUANTDINGER_PORT.enabled, false);
  assert.equal(THEMES.defaultTheme, "riverton-dark");
  assert.equal(THEMES.light.length, 3);
  assert.equal(THEMES.dark.length, 3);
  assert.equal(DOMAINS.frozen, true);
  assert.equal(DOMAINS.client, "agentnovas.com");
  assert.equal(PRODUCT_PARAMETERS_CONFIRMED_AT, "2026-08-24");
});

test("改变硬边界的参数必须有对应 ADR", async () => {
  // 参数冻结容易掩盖「顺带改了一条硬边界」。这条把它变成可被断言的缺失。
  assert.equal(BOUNDARY_CHANGES_REQUIRING_ADR.length, 2);
  const adrNumbers = new Set(BOUNDARY_CHANGES_REQUIRING_ADR.map((entry) => entry.adr));
  for (const number of adrNumbers) {
    const adr = await read(`docs/adr/${number}-confirmed-product-parameters-and-boundary-changes.md`);
    assert.match(adr, /状态：Accepted/);
  }
  const adr = await read("docs/adr/0024-confirmed-product-parameters-and-boundary-changes.md");
  // 提现改的是 deposit-only 边界，不是 INV-11——ADR 必须把两者分清。
  assert.match(adr, /deposit-only/);
  assert.match(adr, /INV-11/);
  assert.match(adr, /平台服务余额/);
  // 产品批准不等于可以出金。
  assert.match(adr, /G5/);
});

test("占位参数模块已被取代，不再有第二份真源", async () => {
  const current = await read("packages/contracts/src/product-parameters.ts");
  assert.match(current, /单一真源/);
  // 参数已全部确认，占位机制不该继续存在——两份真源迟早会分叉。
  await assert.rejects(
    read("packages/contracts/src/provisional-product-parameters.ts"),
    (error) => error.code === "ENOENT",
    "占位参数模块应已删除",
  );
});
