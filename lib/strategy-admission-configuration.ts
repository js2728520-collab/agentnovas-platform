import { createHash } from "node:crypto";

import {
  defaultStrategyAdmissionThresholds,
  type StrategyAdmissionThresholds,
} from "../packages/contracts/src/strategy-admission.ts";
import { ResearchApiError } from "./research-errors.ts";

/**
 * 策略准入门槛配置族（P-05 `operatorConfigurableThresholds`）。
 *
 * 门槛决定谁能上架给客户跟随，改错的后果是一批不合格策略进入广场——因此走版本化配置的
 * 完整 draft/test/approve/schedule/activate/rollback，而不是一个可即时修改的数值。
 *
 * **判定方向是只能收紧，不能放宽。** 配置可以把 180 天回测要求提到 365 天，但不能降到
 * 90 天。理由与 feature flag「active 只能进一步收窄环境 Gate」相同：已冻结的 P-05 是产品
 * 承诺的下限，配置是对它的进一步限制，不是新的授权来源。想真正放宽门槛，要改 P-05 并走
 * ADR，而不是在运维端点几下。
 */

export const STRATEGY_ADMISSION_FAMILY = Object.freeze({
  kind: "strategy_admission",
  key: "platform.strategy_admission",
  audience: "shared",
  schemaVersion: 1,
});

const TESTER_ID = "strategy-admission-v1";
const RISK_TIERS = ["conservative", "balanced", "aggressive"] as const;
const NUMERIC_FIELDS = ["minimumBacktestDays", "minimumTrades", "minimumNetReturnPct", "minimumPaperTradingDays"] as const;
const BOOLEAN_FIELDS = ["requiresPaperTradingPeriod", "requiresManualReview"] as const;
const ALLOWED_FIELDS = [...NUMERIC_FIELDS, ...BOOLEAN_FIELDS, "maximumDrawdownPctByTier"] as const;

function schemaError(message: string, fields?: string[]): never {
  throw new ResearchApiError(
    "CONFIGURATION_FAMILY_SCHEMA_INVALID",
    message,
    422,
    fields?.length ? { fields } : undefined,
  );
}

export function isStrategyAdmissionFamily(input: {
  kind: string;
  key: string;
  audience: string;
  schemaVersion: number;
}) {
  return input.kind === STRATEGY_ADMISSION_FAMILY.kind
    && input.key === STRATEGY_ADMISSION_FAMILY.key
    && input.audience === STRATEGY_ADMISSION_FAMILY.audience
    && input.schemaVersion === STRATEGY_ADMISSION_FAMILY.schemaVersion;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    schemaError(`${label} 必须是 ${minimum}–${maximum} 的数值`, [label]);
  }
  return value;
}

/** payload 与门槛结构一一对应；字段必须齐全，不允许部分覆盖。 */
export function normalizeStrategyAdmissionPayload(payload: unknown): StrategyAdmissionThresholds {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    schemaError("准入门槛 payload 必须是对象");
  }
  const value = payload as Record<string, unknown>;
  const extras = Object.keys(value).filter((key) => !(ALLOWED_FIELDS as readonly string[]).includes(key));
  if (extras.length) schemaError("准入门槛 payload 含未知字段", extras);
  const missing = ALLOWED_FIELDS.filter((key) => !(key in value));
  // 不允许部分覆盖：缺字段时「沿用默认」会让 payload 的含义取决于代码当时的默认值，
  // 同一份配置在不同版本的代码上得到不同门槛。
  if (missing.length) schemaError("准入门槛 payload 缺少字段", [...missing]);

  const drawdown = value.maximumDrawdownPctByTier;
  if (!drawdown || typeof drawdown !== "object" || Array.isArray(drawdown)) {
    schemaError("maximumDrawdownPctByTier 必须是对象", ["maximumDrawdownPctByTier"]);
  }
  const tierValues = drawdown as Record<string, unknown>;
  const tierExtras = Object.keys(tierValues).filter((key) => !(RISK_TIERS as readonly string[]).includes(key));
  if (tierExtras.length) schemaError("maximumDrawdownPctByTier 含未知风险档位", tierExtras);
  const maximumDrawdownPctByTier = {} as StrategyAdmissionThresholds["maximumDrawdownPctByTier"];
  for (const tier of RISK_TIERS) {
    maximumDrawdownPctByTier[tier] = finiteNumber(tierValues[tier], `maximumDrawdownPctByTier.${tier}`, 0.1, 100);
  }

  for (const field of BOOLEAN_FIELDS) {
    if (typeof value[field] !== "boolean") schemaError(`${field} 必须是布尔值`, [field]);
  }

  return {
    minimumBacktestDays: finiteNumber(value.minimumBacktestDays, "minimumBacktestDays", 1, 3_650),
    minimumTrades: finiteNumber(value.minimumTrades, "minimumTrades", 1, 100_000),
    minimumNetReturnPct: finiteNumber(value.minimumNetReturnPct, "minimumNetReturnPct", -100, 1_000),
    minimumPaperTradingDays: finiteNumber(value.minimumPaperTradingDays, "minimumPaperTradingDays", 0, 3_650),
    maximumDrawdownPctByTier,
    requiresPaperTradingPeriod: value.requiresPaperTradingPeriod as boolean,
    requiresManualReview: value.requiresManualReview as boolean,
  };
}

/** 逐项判断一份门槛相对已冻结 P-05 是否只收紧未放宽。 */
export function looseningsAgainstBaseline(candidate: StrategyAdmissionThresholds): string[] {
  const baseline = defaultStrategyAdmissionThresholds();
  const loosened: string[] = [];
  if (candidate.minimumBacktestDays < baseline.minimumBacktestDays) loosened.push("minimumBacktestDays");
  if (candidate.minimumTrades < baseline.minimumTrades) loosened.push("minimumTrades");
  if (candidate.minimumNetReturnPct < baseline.minimumNetReturnPct) loosened.push("minimumNetReturnPct");
  for (const tier of RISK_TIERS) {
    // 回撤是上限，放宽的方向是**变大**。
    if (candidate.maximumDrawdownPctByTier[tier] > baseline.maximumDrawdownPctByTier[tier]) {
      loosened.push(`maximumDrawdownPctByTier.${tier}`);
    }
  }
  // 人工审核不可被配置关掉：它是 P-05 里唯一一道非数值的关。
  if (baseline.requiresManualReview && !candidate.requiresManualReview) loosened.push("requiresManualReview");
  if (baseline.requiresPaperTradingPeriod && !candidate.requiresPaperTradingPeriod) {
    loosened.push("requiresPaperTradingPeriod");
  }
  if (candidate.requiresPaperTradingPeriod && candidate.minimumPaperTradingDays < baseline.minimumPaperTradingDays) {
    loosened.push("minimumPaperTradingDays");
  }
  return loosened;
}

/**
 * 确定性测试器。
 *
 * schema 之外的产品断言只有一条，但它是这个配置族存在的意义：**不得放宽已冻结的 P-05**。
 * 没有这条，运维就能把回撤上限从 15% 调到 60%，让一批本该被拒的策略进入广场——而整个
 * draft/test/approve 流程会显示一切正常。
 */
export function runStrategyAdmissionTest(input: {
  kind: string;
  key: string;
  audience: string;
  schemaVersion: number;
  payload: unknown;
}) {
  if (!isStrategyAdmissionFamily(input)) {
    throw new ResearchApiError("CONFIGURATION_FAMILY_UNREGISTERED", "该准入门槛配置族尚未注册", 422);
  }
  const payload = normalizeStrategyAdmissionPayload(input.payload);
  const loosened = looseningsAgainstBaseline(payload);
  const checks = [
    { id: "schema", passed: true },
    { id: "no_loosening_against_frozen_baseline", passed: loosened.length === 0 },
  ];
  const failed = checks.filter((check) => !check.passed).map((check) => check.id);
  const evidence = JSON.stringify({
    testerId: TESTER_ID,
    kind: input.kind,
    key: input.key,
    audience: input.audience,
    schemaVersion: input.schemaVersion,
    payload,
    checks,
    loosened,
    result: failed.length ? "failed" : "passed",
  });
  return {
    result: failed.length ? ("failed" as const) : ("passed" as const),
    failedChecks: failed,
    evidenceSha256: createHash("sha256").update(evidence, "utf8").digest("hex"),
    testerId: TESTER_ID,
  };
}

/**
 * 运行时消费者：把 active 配置叠加到已冻结的 P-05 上。
 *
 * 与测试器同方向——**只取更严格的那个值**。即使某个放宽的版本因为绕过写入路径而被激活，
 * 消费端仍不会真的放宽。测试器挡的是「不该被批准」，这里挡的是「已经被批准了怎么办」。
 */
export function resolveStrategyAdmissionThresholds(activePayload: unknown): StrategyAdmissionThresholds {
  const baseline = defaultStrategyAdmissionThresholds();
  if (activePayload === null || activePayload === undefined) return baseline;
  let candidate: StrategyAdmissionThresholds;
  try {
    candidate = normalizeStrategyAdmissionPayload(activePayload);
  } catch {
    // 非法配置回落到已冻结的 P-05，而不是无门槛。
    return baseline;
  }
  const tiers = {} as StrategyAdmissionThresholds["maximumDrawdownPctByTier"];
  for (const tier of RISK_TIERS) {
    tiers[tier] = Math.min(candidate.maximumDrawdownPctByTier[tier], baseline.maximumDrawdownPctByTier[tier]);
  }
  return {
    minimumBacktestDays: Math.max(candidate.minimumBacktestDays, baseline.minimumBacktestDays),
    minimumTrades: Math.max(candidate.minimumTrades, baseline.minimumTrades),
    minimumNetReturnPct: Math.max(candidate.minimumNetReturnPct, baseline.minimumNetReturnPct),
    minimumPaperTradingDays: Math.max(candidate.minimumPaperTradingDays, baseline.minimumPaperTradingDays),
    maximumDrawdownPctByTier: tiers,
    requiresPaperTradingPeriod: candidate.requiresPaperTradingPeriod || baseline.requiresPaperTradingPeriod,
    requiresManualReview: candidate.requiresManualReview || baseline.requiresManualReview,
  };
}
