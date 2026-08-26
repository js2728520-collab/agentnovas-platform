/**
 * AI 助手的平台事实快照。
 *
 * 助手要回答「月卡多少钱」「分成怎么算」「会不会动我的钱」这类问题。
 * 这些数字是合同事实，**编造就是向客户虚假陈述**，所以全部从既有常量派生，
 * 这里不出现任何第二份数字。
 *
 * 政策条款（非托管、无提现权限、风控不可被模型覆盖）在代码里没有常量表示，
 * 它们是根 CLAUDE.md 的不变量。这里是它们唯一的面向客户的措辞，
 * 由 tests/ai-platform-facts.test.mjs 钉住，改动会被发现。
 */

import { betaPaperCapitalUsdt, commercialBetaPlans, performanceFeeCurrency, performanceFeeCycle } from "./commercial-beta.ts";
import { officialTradingHallStrategies, tradingHallAgentCatalog } from "./trading-hall.ts";

export type PlatformFactSnapshot = {
  product: { name: string; positioning: string; stage: string };
  membership: {
    plans: Array<{ name: string; priceUsd: string; durationDays: number | null; aiCredits: number; performanceFeeRate: string }>;
    performanceFee: { cadence: string; timezone: string; currency: string; rule: string };
  };
  officialStrategies: Array<{
    name: string;
    positioning: string;
    symbols: readonly string[];
    decisionTimeframes: readonly string[];
    typicalHoldingPeriod: string;
    maxAssetAllocationPct: number;
    dailyLossHaltPct: number;
    maxDrawdownPct: number;
  }>;
  decisionChain: Array<{ sequence: number; name: string; question: string; outputName: string }>;
  paperCapitalUsdt: string;
  policies: readonly string[];
};

/** 客户资金与权限的边界。对应根 CLAUDE.md 的 INV-1 / INV-7 / INV-11。 */
const policies = [
  "非托管：客户的钱始终在客户自己的交易所账户里，平台不归集资金。",
  "平台永不持有客户交易所账户的提现权限，跟单只需要读取和交易权限。这条由数据库约束强制，不是承诺。",
  "绩效分成从客户预充的服务余额扣除，平台不具备自动划扣能力，且需要双人复核。",
  "绩效分成按 UTC 自然周结算，采用高水位线：亏损周不计费，需先补回高水位线以上的部分才重新计费。",
  "风控由确定性代码执行，AI 只能解释、提案、质疑，不能改写风控结论。",
  "数据不足、模型超时或风控不可用时不产生新开仓；平仓能力不依赖 AI 在线。",
  "当前 Beta 阶段只跑服务器记账的模拟成交（paper），实盘下单路由是关闭的。模拟盈亏不可提取。",
  "平台卖的是可解释、可审计的决策过程，不承诺收益。",
] as const;

export function buildPlatformFactSnapshot(): PlatformFactSnapshot {
  return {
    product: {
      name: "Riverton Capital",
      positioning: "七智能体决策链驱动的策略跟单平台，AgentNovas 是其技术与代码品牌。",
      stage: "受邀制 Beta",
    },
    membership: {
      plans: commercialBetaPlans.map((plan) => ({
        name: plan.name,
        priceUsd: plan.priceUsd,
        durationDays: plan.durationDays,
        aiCredits: plan.aiCredits,
        performanceFeeRate: plan.performanceFeeRate,
      })),
      performanceFee: {
        cadence: performanceFeeCycle.cadence,
        timezone: performanceFeeCycle.timezone,
        currency: performanceFeeCurrency,
        rule: "高水位线：只对超过历史最高权益的部分计费，亏损周不计费。",
      },
    },
    officialStrategies: officialTradingHallStrategies.map((strategy) => ({
      name: strategy.name,
      positioning: strategy.positioning,
      symbols: strategy.symbols,
      decisionTimeframes: strategy.decisionTimeframes,
      typicalHoldingPeriod: strategy.typicalHoldingPeriod,
      maxAssetAllocationPct: strategy.risk.maxAssetAllocationPct,
      dailyLossHaltPct: strategy.risk.dailyLossHaltPct,
      maxDrawdownPct: strategy.risk.maxDrawdownPct,
    })),
    decisionChain: tradingHallAgentCatalog.map((agent) => ({
      sequence: agent.sequence,
      name: agent.name,
      question: agent.question,
      outputName: agent.outputName,
    })),
    paperCapitalUsdt: betaPaperCapitalUsdt,
    policies,
  };
}
