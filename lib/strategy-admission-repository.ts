import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  evaluateStrategyAdmission,
  riskTierFromLevel,
  type StrategyAdmissionResult,
  type StrategyAdmissionThresholds,
} from "../packages/contracts/src/strategy-admission.ts";
import { ResearchApiError } from "./research-errors.ts";
import {
  resolveStrategyAdmissionThresholds,
  STRATEGY_ADMISSION_FAMILY,
} from "./strategy-admission-configuration.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ActiveAdmissionThresholds = {
  thresholds: StrategyAdmissionThresholds;
  configurationVersionId: string | null;
  payloadSha256: string | null;
};

/**
 * 读取当前生效的准入门槛。
 *
 * 网关不可用或没有 active 版本时回落到已冻结的 P-05——**不是回落到无门槛**。准入判定
 * 失败关闭的方向是「按基线拒绝」，不是「查不到就放行」。
 */
export async function loadActiveAdmissionThresholds(database: Queryable): Promise<ActiveAdmissionThresholds> {
  try {
    const result = await database.query<{ configuration_version_id: string; payload_json: unknown; payload_sha256: string }>(
      "SELECT configuration_version_id, payload_json, payload_sha256 FROM strategy_admission_current($1)",
      [STRATEGY_ADMISSION_FAMILY.key],
    );
    const row = result.rows[0];
    if (!row) return { thresholds: resolveStrategyAdmissionThresholds(null), configurationVersionId: null, payloadSha256: null };
    return {
      thresholds: resolveStrategyAdmissionThresholds(row.payload_json),
      configurationVersionId: row.configuration_version_id,
      payloadSha256: row.payload_sha256,
    };
  } catch {
    return { thresholds: resolveStrategyAdmissionThresholds(null), configurationVersionId: null, payloadSha256: null };
  }
}

export type AdmissionEvaluation = {
  evaluationId: string;
  strategyId: string;
  strategyVersion: number;
  validationId: string;
  result: StrategyAdmissionResult;
  thresholds: StrategyAdmissionThresholds;
  configurationVersionId: string | null;
};

type ValidationRow = {
  id: string;
  period_start: string | null;
  period_end: string | null;
  sample_size: number | null;
  net_return_pct: number | null;
  max_drawdown_pct: number | null;
};

/**
 * 按最新一次通过的回测判定某个策略版本的准入，并把逐项结果落库。
 *
 * PRD 6.5：「不得用口头结论替代」。因此判定结果连同依据的回测、档位与门槛版本一起记录
 * ——审核人看到的是哪几条不达标，事后也能复核当时按的是哪套门槛。
 */
export async function evaluateAndRecordAdmission(
  database: Queryable,
  input: {
    strategyId: string;
    strategyVersion: number;
    riskLevel: string | null;
    validationLabel: string;
    paperTradingDays?: number;
  },
): Promise<AdmissionEvaluation> {
  const validation = await database.query<ValidationRow>(`
    SELECT id, period_start, period_end, sample_size, net_return_pct, max_drawdown_pct
      FROM strategy_validations
     WHERE strategy_id = $1 AND strategy_version = $2 AND kind = 'backtest' AND status = 'passed'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1
  `, [input.strategyId, input.strategyVersion]);

  const report = validation.rows[0];
  if (!report) {
    // 没有回测就没有可判定的事实。这里返回错误而不是「判定为不通过」：两者对作者是不同
    // 的指引——前者是「先去跑回测」，后者是「你的策略不达标」。
    throw new ResearchApiError("STRATEGY_BACKTEST_REQUIRED", "该策略版本还没有通过的回测报告", 409);
  }

  const { thresholds, configurationVersionId, payloadSha256 } = await loadActiveAdmissionThresholds(database);
  const result = evaluateStrategyAdmission({
    riskTier: riskTierFromLevel(input.riskLevel),
    backtestPeriodStart: report.period_start ?? "",
    backtestPeriodEnd: report.period_end ?? "",
    sampleSize: report.sample_size ?? Number.NaN,
    netReturnPct: report.net_return_pct ?? Number.NaN,
    maxDrawdownPct: report.max_drawdown_pct ?? Number.NaN,
    paperTradingDays: input.paperTradingDays ?? 0,
    validationLabel: input.validationLabel,
  }, thresholds);

  const evaluationId = randomUUID();
  const stored = await database.query<{ id: string }>(`
    INSERT INTO strategy_admission_evaluations (
      id, strategy_id, strategy_version, validation_id, risk_tier, meets_thresholds,
      checks_json, thresholds_configuration_version_id, thresholds_payload_sha256
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    ON CONFLICT (strategy_id, strategy_version) DO UPDATE
      SET validation_id = EXCLUDED.validation_id,
          risk_tier = EXCLUDED.risk_tier,
          meets_thresholds = EXCLUDED.meets_thresholds,
          checks_json = EXCLUDED.checks_json,
          thresholds_configuration_version_id = EXCLUDED.thresholds_configuration_version_id,
          thresholds_payload_sha256 = EXCLUDED.thresholds_payload_sha256,
          evaluated_at = now()
    RETURNING id
  `, [
    evaluationId, input.strategyId, input.strategyVersion, report.id,
    riskTierFromLevel(input.riskLevel), result.meetsThresholds,
    JSON.stringify(result.checks), configurationVersionId, payloadSha256,
  ]);

  return {
    evaluationId: stored.rows[0].id,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    validationId: report.id,
    result,
    thresholds,
    configurationVersionId,
  };
}

export async function loadAdmissionEvaluation(
  database: Queryable,
  input: { strategyId: string; strategyVersion: number },
): Promise<{ meetsThresholds: boolean; checks: unknown[]; riskTier: string; evaluatedAt: string } | null> {
  const result = await database.query<{
    meets_thresholds: boolean; checks_json: unknown[]; risk_tier: string; evaluated_at: Date;
  }>(`
    SELECT meets_thresholds, checks_json, risk_tier, evaluated_at
      FROM strategy_admission_evaluations
     WHERE strategy_id = $1 AND strategy_version = $2
  `, [input.strategyId, input.strategyVersion]);
  const row = result.rows[0];
  return row ? {
    meetsThresholds: row.meets_thresholds,
    checks: row.checks_json,
    riskTier: row.risk_tier,
    evaluatedAt: row.evaluated_at.toISOString(),
  } : null;
}
