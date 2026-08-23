import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { ResearchStrategyDsl } from "../packages/domain/src/strategy-dsl.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export async function withResearchCandidateSaveLock<T>(
  database: Pool,
  candidateId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const normalizedCandidateId = candidateId.trim();
  if (!normalizedCandidateId || normalizedCandidateId.length > 200) {
    throw new Error("候选策略 ID 无效");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`strategy-candidate-save:${normalizedCandidateId}`],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reserveResearchModelCalls(database: Queryable, input: {
  runId: string;
  workerId: string;
  count?: number;
}) {
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("模型调用预留数量无效");
  const result = await database.query<{ model_calls_used: number; model_call_budget: number }>(`
    UPDATE strategy_research_runs
    SET model_calls_used = model_calls_used + $3, updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      AND cancel_requested_at IS NULL
      AND model_calls_used + $3 <= model_call_budget
    RETURNING model_calls_used, model_call_budget
  `, [input.runId, input.workerId, count]);
  if (!result.rows[0]) throw new Error("任务租约无效、任务已取消或模型调用预算已耗尽");
  return result.rows[0];
}

export async function patchResearchRunBrief(database: Queryable, input: {
  runId: string;
  workerId: string;
  brief: Record<string, unknown>;
}) {
  const result = await database.query<{ brief_json: Record<string, unknown> }>(`
    UPDATE strategy_research_runs
    SET brief_json = brief_json || $3::jsonb, updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      AND stage = 'requirements' AND cancel_requested_at IS NULL
    RETURNING brief_json
  `, [input.runId, input.workerId, JSON.stringify(input.brief)]);
  if (!result.rows[0]) throw new Error("任务租约无效、阶段不匹配或任务已取消");
  return result.rows[0].brief_json;
}

export async function patchResearchRunResult(database: Queryable, input: {
  runId: string;
  workerId: string;
  patch: Record<string, unknown>;
  backtests?: number;
}) {
  const result = await database.query(`
    UPDATE strategy_research_runs
    SET result_json = COALESCE(result_json, '{}'::jsonb) || $3::jsonb,
        backtests_used = backtests_used + $4,
        updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      AND cancel_requested_at IS NULL
      AND backtests_used + $4 <= backtest_budget
    RETURNING result_json, model_calls_used, backtests_used
  `, [input.runId, input.workerId, JSON.stringify(input.patch), input.backtests ?? 0]);
  if (!result.rows[0]) throw new Error("任务租约无效或回测预算已耗尽");
  return result.rows[0];
}

export async function upsertResearchCandidate(database: Queryable, input: {
  runId: string;
  key: string;
  strategyFamily: string;
  sourceRole: string;
  dsl: ResearchStrategyDsl;
}) {
  const result = await database.query(`
    INSERT INTO strategy_candidates (
      id, run_id, candidate_key, strategy_family, source_role, dsl_json
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (run_id, candidate_key) DO UPDATE SET
      strategy_family = EXCLUDED.strategy_family,
      source_role = EXCLUDED.source_role,
      dsl_json = EXCLUDED.dsl_json,
      updated_at = now()
    RETURNING id
  `, [crypto.randomUUID(), input.runId, input.key, input.strategyFamily, input.sourceRole, JSON.stringify(input.dsl)]);
  return String(result.rows[0].id);
}

export async function loadInternalCandidates(database: Queryable, runId: string) {
  const result = await database.query<{
    id: string;
    candidate_key: string;
    strategy_family: string;
    source_role: string;
    dsl_json: ResearchStrategyDsl;
    status: string;
    score: number | null;
    rank: number | null;
    validation_label: string;
    rejection_reasons_json: string[];
  }>("SELECT * FROM strategy_candidates WHERE run_id = $1 ORDER BY created_at, id", [runId]);
  return result.rows.map(row => ({
    id: row.id,
    key: row.candidate_key,
    strategyFamily: row.strategy_family,
    sourceRole: row.source_role,
    dsl: row.dsl_json,
    status: row.status,
    score: row.score,
    rank: row.rank,
    validationLabel: row.validation_label,
    rejectionReasons: row.rejection_reasons_json,
  }));
}

export async function saveResearchEvaluation(database: Queryable, input: {
  runId: string;
  candidateId: string;
  kind: string;
  windowIndex: number;
  periodStart: Date;
  periodEnd: Date;
  metrics: Record<string, unknown>;
  dataQuality: Record<string, unknown>;
  parameterSetSha256: string;
  dataSliceSha256: string;
  backtestEngineVersion: string;
  costScenario: string;
  passed: boolean;
  finalHoldout?: boolean;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.parameterSetSha256) || !/^[a-f0-9]{64}$/.test(input.dataSliceSha256)) {
    throw new Error("研发评估审计哈希格式无效");
  }
  if (!input.backtestEngineVersion.trim() || !input.costScenario.trim()) throw new Error("研发评估审计版本或成本场景缺失");
  const result = await database.query(`
    INSERT INTO strategy_evaluations (
      id, run_id, candidate_id, evaluation_kind, window_index,
      period_start, period_end, metrics_json, data_quality_json,
      parameter_set_sha256, data_slice_sha256, backtest_engine_version, cost_scenario,
      passed, is_final_holdout
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (candidate_id, evaluation_kind, window_index) DO UPDATE
    SET evaluation_kind = EXCLUDED.evaluation_kind
    WHERE strategy_evaluations.parameter_set_sha256 = EXCLUDED.parameter_set_sha256
      AND strategy_evaluations.data_slice_sha256 = EXCLUDED.data_slice_sha256
      AND strategy_evaluations.backtest_engine_version = EXCLUDED.backtest_engine_version
      AND strategy_evaluations.cost_scenario = EXCLUDED.cost_scenario
    RETURNING id
  `, [
    crypto.randomUUID(), input.runId, input.candidateId, input.kind, input.windowIndex,
    input.periodStart, input.periodEnd, JSON.stringify(input.metrics), JSON.stringify(input.dataQuality),
    input.parameterSetSha256, input.dataSliceSha256, input.backtestEngineVersion, input.costScenario,
    input.passed, input.finalHoldout ?? false,
  ]);
  if (!result.rows[0]) throw new Error("同一研发评估检查点的审计指纹不一致");
}

export async function updateCandidateValidation(database: Queryable, input: {
  candidateId: string;
  status: "qualified" | "rejected";
  score: number;
  validationLabel: "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";
  reasons: string[];
  dsl?: ResearchStrategyDsl;
}) {
  await database.query(`
    UPDATE strategy_candidates
    SET status = $2, score = $3, validation_label = $4,
        rejection_reasons_json = $5::jsonb,
        dsl_json = COALESCE($6::jsonb, dsl_json),
        updated_at = now()
    WHERE id = $1
  `, [
    input.candidateId,
    input.status,
    input.score,
    input.validationLabel,
    JSON.stringify(input.reasons),
    input.dsl ? JSON.stringify(input.dsl) : null,
  ]);
}

export async function setCandidateRanks(database: Queryable, ranked: Array<{ id: string; rank: number }>) {
  for (const candidate of ranked) {
    await database.query("UPDATE strategy_candidates SET rank = $2, updated_at = now() WHERE id = $1", [candidate.id, candidate.rank]);
  }
}

export async function getOwnedCandidateForSave(database: Queryable, input: {
  runId: string;
  candidateId: string;
  ownerUserId: string;
}) {
  const result = await database.query<{
    id: string;
    dsl_json: ResearchStrategyDsl;
    strategy_family: string;
    validation_label: "UNVERIFIED" | "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";
    saved_strategy_id: string | null;
    conversation_id: string | null;
  }>(`
    SELECT candidate.id, candidate.dsl_json, candidate.strategy_family,
           candidate.validation_label, candidate.saved_strategy_id, run.conversation_id
    FROM strategy_candidates AS candidate
    JOIN strategy_research_runs AS run ON run.id = candidate.run_id
    WHERE candidate.id = $1 AND candidate.run_id = $2 AND run.owner_user_id = $3
  `, [input.candidateId, input.runId, input.ownerUserId]);
  const row = result.rows[0];
  return row ? {
    id: row.id,
    dsl: row.dsl_json,
    strategyFamily: row.strategy_family,
    validationLabel: row.validation_label,
    savedStrategyId: row.saved_strategy_id,
    conversationId: row.conversation_id,
  } : null;
}

export async function getSavedStrategyDraftForCandidate(database: Queryable, input: {
  candidateId: string;
}) {
  const result = await database.query<{
    strategy_id: string;
    strategy_version_id: string;
    version: number;
    specification_json: string;
    validation_label: "UNVERIFIED" | "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";
  }>(`
    SELECT candidate.saved_strategy_id AS strategy_id,
           candidate.saved_strategy_version_id AS strategy_version_id,
           version.version,
           version.specification_json,
           strategy.validation_label
    FROM strategy_candidates AS candidate
    JOIN community_strategies AS strategy
      ON strategy.id = candidate.saved_strategy_id
    JOIN strategy_versions AS version
      ON version.id = candidate.saved_strategy_version_id
     AND version.strategy_id = strategy.id
    WHERE candidate.id = $1
  `, [input.candidateId]);
  const row = result.rows[0];
  return row ? {
    strategyId: row.strategy_id,
    strategyVersionId: row.strategy_version_id,
    version: row.version,
    specification: JSON.parse(row.specification_json) as ResearchStrategyDsl,
    validationLabel: row.validation_label,
  } : null;
}

export async function getOwnedStrategyDraftById(database: Queryable, input: {
  strategyId: string;
  ownerUserId: string;
}) {
  const result = await database.query<{
    strategy_id: string;
    strategy_version_id: string;
    version: number;
    specification_json: string;
    validation_label: "UNVERIFIED" | "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";
  }>(`
    SELECT strategy.id AS strategy_id,
           version.id AS strategy_version_id,
           version.version,
           version.specification_json,
           strategy.validation_label
    FROM community_strategies AS strategy
    JOIN strategy_versions AS version ON version.strategy_id = strategy.id
    WHERE strategy.id = $1 AND strategy.author_user_id = $2
    ORDER BY version.version DESC
    LIMIT 1
  `, [input.strategyId, input.ownerUserId]);
  const row = result.rows[0];
  return row ? {
    strategyId: row.strategy_id,
    strategyVersionId: row.strategy_version_id,
    version: row.version,
    specification: JSON.parse(row.specification_json) as ResearchStrategyDsl,
    validationLabel: row.validation_label,
  } : null;
}

export async function markCandidateSaved(database: Queryable, input: {
  candidateId: string;
  strategyId: string;
  strategyVersionId: string;
}) {
  const result = await database.query<{ saved_strategy_id: string; saved_strategy_version_id: string }>(`
    UPDATE strategy_candidates
    SET saved_strategy_id = COALESCE(saved_strategy_id, $2),
        saved_strategy_version_id = COALESCE(saved_strategy_version_id, $3),
        updated_at = now()
    WHERE id = $1
      AND (saved_strategy_id IS NULL OR saved_strategy_id = $2)
      AND (saved_strategy_version_id IS NULL OR saved_strategy_version_id = $3)
    RETURNING saved_strategy_id, saved_strategy_version_id
  `, [input.candidateId, input.strategyId, input.strategyVersionId]);
  if (!result.rows[0]) throw new Error("候选策略已保存为其他策略记录");
  return result.rows[0].saved_strategy_id;
}

export async function completeResearchRun(database: Pool | PoolClient, input: {
  runId: string;
  workerId: string;
  conclusion: "QUALIFIED" | "NOT_QUALIFIED";
  result: Record<string, unknown>;
  event: { title: string; content: Record<string, unknown> };
}) {
  const release = "totalCount" in database;
  const client: PoolClient = release ? await (database as Pool).connect() : database as PoolClient;
  try {
    await client.query("BEGIN");
    const run = await client.query<{ event_sequence: string }>(`
      UPDATE strategy_research_runs
      SET stage = 'completed', status = 'completed', progress = 100,
          final_conclusion = $3, result_json = COALESCE(result_json, '{}'::jsonb) || $4::jsonb,
          event_sequence = event_sequence + 1, completed_at = now(), updated_at = now(),
          lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      RETURNING event_sequence
    `, [input.runId, input.workerId, input.conclusion, JSON.stringify(input.result)]);
    if (!run.rows[0]) throw new Error("任务租约无效，不能完成报告");
    await client.query(`
      INSERT INTO strategy_agent_events (id, run_id, sequence, role, event_type, title, content_json)
      VALUES ($1, $2, $3, 'report', 'final_report', $4, $5::jsonb)
    `, [crypto.randomUUID(), input.runId, run.rows[0].event_sequence, input.event.title, JSON.stringify(input.event.content)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (release) client.release();
  }
}

export async function markResearchRunError(database: Queryable, input: {
  runId: string;
  workerId: string;
  code: string;
  publicMessage: string;
}) {
  const result = await database.query<QueryResultRow & { status: string }>(`
    UPDATE strategy_research_runs
    SET status = CASE WHEN attempts >= max_retries THEN 'failed' ELSE 'retry_wait' END,
        next_attempt_at = CASE WHEN attempts >= max_retries THEN NULL ELSE now() + interval '20 seconds' * attempts END,
        completed_at = CASE WHEN attempts >= max_retries THEN now() ELSE NULL END,
        last_error_code = $3, last_error_message = $4,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND status = 'running'
    RETURNING status
  `, [input.runId, input.workerId, input.code, input.publicMessage.slice(0, 500)]);
  return result.rows[0]?.status ?? null;
}
