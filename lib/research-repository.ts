import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { ResearchStrategyDsl } from "./strategy-dsl.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

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
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (run_id, candidate_key) DO UPDATE SET
      strategy_family = EXCLUDED.strategy_family,
      source_role = EXCLUDED.source_role,
      dsl_json = EXCLUDED.dsl_json,
      updated_at = now()
    RETURNING id
  `, [crypto.randomUUID(), input.runId, input.key, input.strategyFamily, input.sourceRole, input.dsl]);
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
  passed: boolean;
  finalHoldout?: boolean;
}) {
  await database.query(`
    INSERT INTO strategy_evaluations (
      id, run_id, candidate_id, evaluation_kind, window_index,
      period_start, period_end, metrics_json, data_quality_json, passed, is_final_holdout
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (candidate_id, evaluation_kind, window_index) DO NOTHING
  `, [
    crypto.randomUUID(), input.runId, input.candidateId, input.kind, input.windowIndex,
    input.periodStart, input.periodEnd, input.metrics, input.dataQuality, input.passed, input.finalHoldout ?? false,
  ]);
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
        rejection_reasons_json = $5,
        dsl_json = COALESCE($6, dsl_json),
        updated_at = now()
    WHERE id = $1
  `, [input.candidateId, input.status, input.score, input.validationLabel, input.reasons, input.dsl ?? null]);
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
    conversation_id: string;
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

export async function markCandidateSaved(database: Queryable, input: {
  candidateId: string;
  strategyId: string;
}) {
  const result = await database.query<{ saved_strategy_id: string }>(`
    UPDATE strategy_candidates
    SET saved_strategy_id = COALESCE(saved_strategy_id, $2), updated_at = now()
    WHERE id = $1 AND (saved_strategy_id IS NULL OR saved_strategy_id = $2)
    RETURNING saved_strategy_id
  `, [input.candidateId, input.strategyId]);
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
      VALUES ($1, $2, $3, 'report', 'final_report', $4, $5)
    `, [crypto.randomUUID(), input.runId, run.rows[0].event_sequence, input.event.title, input.event.content]);
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
