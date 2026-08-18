import type { Pool, PoolClient, QueryResultRow } from "pg";

import { nextResearchStage, researchStageProgress } from "./strategy-research-state-machine.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

type ResearchMode = "quick" | "standard" | "deep";

type ResearchRunRow = QueryResultRow & {
  id: string;
  owner_user_id: string;
  conversation_id: string;
  exchange_account_id: string;
  mode: ResearchMode;
  stage: string;
  status: string;
  progress: number;
  brief_json: Record<string, unknown>;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempts: number;
  cancel_requested_at: Date | null;
  result_json: Record<string, unknown> | null;
  final_conclusion: "QUALIFIED" | "NOT_QUALIFIED" | null;
  event_sequence: string;
  candidate_budget: number;
  backtest_budget: number;
  model_call_budget: number;
  backtests_used: number;
  model_calls_used: number;
  last_error_code: string | null;
  last_error_message: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function runFromRow(row: ResearchRunRow) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    exchangeAccountId: row.exchange_account_id,
    mode: row.mode,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    brief: row.brief_json,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    cancelRequestedAt: row.cancel_requested_at,
    result: row.result_json,
    finalConclusion: row.final_conclusion,
    eventSequence: Number(row.event_sequence),
    candidateBudget: row.candidate_budget,
    backtestBudget: row.backtest_budget,
    modelCallBudget: row.model_call_budget,
    backtestsUsed: row.backtests_used,
    modelCallsUsed: row.model_calls_used,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getOwnedResearchRun(database: Queryable, input: {
  runId: string;
  ownerUserId: string;
}) {
  const result = await database.query<ResearchRunRow>(`
    SELECT * FROM strategy_research_runs WHERE id = $1 AND owner_user_id = $2
  `, [input.runId, input.ownerUserId]);
  return result.rows[0] ? runFromRow(result.rows[0]) : null;
}

export async function listResearchEvents(database: Queryable, input: {
  runId: string;
  ownerUserId: string;
  afterSequence?: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const result = await database.query<{
    id: string;
    sequence: string;
    role: string;
    event_type: string;
    title: string;
    content_json: Record<string, unknown>;
    created_at: Date;
  }>(`
    SELECT event.id, event.sequence, event.role, event.event_type,
           event.title, event.content_json, event.created_at
    FROM strategy_agent_events AS event
    JOIN strategy_research_runs AS run ON run.id = event.run_id
    WHERE event.run_id = $1 AND run.owner_user_id = $2 AND event.sequence > $3
    ORDER BY event.sequence
    LIMIT $4
  `, [input.runId, input.ownerUserId, input.afterSequence ?? 0, limit]);
  return result.rows.map(row => ({
    id: row.id,
    sequence: Number(row.sequence),
    role: row.role,
    type: row.event_type,
    title: row.title,
    content: row.content_json,
    createdAt: row.created_at,
  }));
}

export async function listResearchCandidates(database: Queryable, input: {
  runId: string;
  ownerUserId: string;
}) {
  const result = await database.query<{
    id: string;
    candidate_key: string;
    strategy_family: string;
    source_role: string;
    dsl_json: Record<string, unknown>;
    status: string;
    rank: number | null;
    score: number | null;
    rejection_reasons_json: string[];
    validation_label: string;
    saved_strategy_id: string | null;
  }>(`
    SELECT candidate.*
    FROM strategy_candidates AS candidate
    JOIN strategy_research_runs AS run ON run.id = candidate.run_id
    WHERE candidate.run_id = $1 AND run.owner_user_id = $2
    ORDER BY candidate.rank NULLS LAST, candidate.score DESC NULLS LAST, candidate.created_at
  `, [input.runId, input.ownerUserId]);
  return result.rows.map(row => ({
    id: row.id,
    key: row.candidate_key,
    strategyFamily: row.strategy_family,
    sourceRole: row.source_role,
    dsl: row.dsl_json,
    status: row.status,
    rank: row.rank,
    score: row.score,
    rejectionReasons: row.rejection_reasons_json,
    validationLabel: row.validation_label,
    savedStrategyId: row.saved_strategy_id,
  }));
}

export async function listResearchEvaluations(database: Queryable, input: {
  runId: string;
  ownerUserId: string;
}) {
  const result = await database.query<{
    id: string;
    candidate_id: string;
    evaluation_kind: string;
    window_index: number;
    period_start: Date;
    period_end: Date;
    metrics_json: Record<string, unknown>;
    data_quality_json: Record<string, unknown>;
    passed: boolean;
    is_final_holdout: boolean;
  }>(`
    SELECT evaluation.*
    FROM strategy_evaluations AS evaluation
    JOIN strategy_research_runs AS run ON run.id = evaluation.run_id
    WHERE evaluation.run_id = $1 AND run.owner_user_id = $2
    ORDER BY evaluation.candidate_id, evaluation.evaluation_kind, evaluation.window_index
  `, [input.runId, input.ownerUserId]);
  return result.rows.map(row => ({
    id: row.id,
    candidateId: row.candidate_id,
    kind: row.evaluation_kind,
    windowIndex: row.window_index,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    metrics: row.metrics_json,
    dataQuality: row.data_quality_json,
    passed: row.passed,
    finalHoldout: row.is_final_holdout,
  }));
}

export async function pauseResearchRunForMissingRoles(database: Queryable, input: {
  runId: string;
  missingRoles: string[];
  workerId?: string;
}) {
  const result = await database.query<ResearchRunRow>(`
    UPDATE strategy_research_runs
    SET status = 'paused_missing_role', lease_owner = NULL, lease_expires_at = NULL,
        attempts = 0,
        last_error_code = 'MISSING_AGENT_ROLE',
        last_error_message = $2,
        updated_at = now()
    WHERE id = $1
      AND cancel_requested_at IS NULL
      AND (
        ($3::text IS NULL AND status = 'queued')
        OR ($3::text IS NOT NULL AND status = 'running' AND lease_owner = $3)
      )
    RETURNING *
  `, [input.runId, `缺少角色配置：${input.missingRoles.join(", ")}`, input.workerId ?? null]);
  if (!result.rows[0]) throw new Error("研发任务不存在、已结束或租约已失效");
  await appendResearchEvent(database as Pool | PoolClient, {
    runId: input.runId,
    role: "orchestrator",
    type: "paused",
    title: "等待管理员配置 Agent 模型",
    content: { missingRoles: input.missingRoles },
  });
  return runFromRow(result.rows[0]);
}

export async function requeueResearchRunsPausedForRoles(database: Queryable) {
  const result = await database.query<ResearchRunRow>(`
    UPDATE strategy_research_runs
    SET status = 'queued',
        last_error_code = NULL,
        last_error_message = NULL,
        next_attempt_at = now(),
        updated_at = now()
    WHERE status = 'paused_missing_role' AND cancel_requested_at IS NULL
    RETURNING *
  `);
  const runs = result.rows.map(runFromRow);
  for (const run of runs) {
    await appendResearchEvent(database as Pool | PoolClient, {
      runId: run.id,
      role: "orchestrator",
      type: "resumed",
      title: "Agent 模型已补齐，任务恢复排队",
      content: {},
    });
  }
  return runs;
}

export async function pauseResearchRunForUserInput(database: Pool | PoolClient, input: {
  runId: string;
  workerId: string;
  requirements: Record<string, unknown>;
  missingFields: Array<Record<string, unknown>>;
  modelName: string;
}) {
  const { client, release } = await poolClient(database);
  try {
    await client.query("BEGIN");
    const result = await client.query<ResearchRunRow>(`
      UPDATE strategy_research_runs
      SET status = 'awaiting_user_input',
          progress = $4,
          attempts = 0,
          result_json = COALESCE(result_json, '{}'::jsonb) || $3::jsonb,
          lease_owner = NULL,
          lease_expires_at = NULL,
          event_sequence = event_sequence + 1,
          updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
        AND stage = 'requirements' AND cancel_requested_at IS NULL
      RETURNING *
    `, [input.runId, input.workerId, JSON.stringify({ requirements: input.requirements }), researchStageProgress("requirements")]);
    if (!result.rows[0]) throw new Error("任务租约已失效、阶段不匹配或任务已取消");
    await client.query(`
      INSERT INTO strategy_agent_events (id, run_id, sequence, role, event_type, title, content_json)
      VALUES ($1, $2, $3, 'requirements', 'input_required', '需要补充会改变策略结果的条件', $4)
    `, [crypto.randomUUID(), input.runId, result.rows[0].event_sequence, {
      modelName: input.modelName,
      missingFields: input.missingFields,
      conclusion: input.requirements.conclusion,
    }]);
    await client.query("COMMIT");
    return runFromRow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (release) client.release();
  }
}

export async function resumeResearchRunWithAnswers(database: Pool | PoolClient, input: {
  runId: string;
  ownerUserId: string;
  answers: Record<string, string | number | boolean>;
}) {
  const { client, release } = await poolClient(database);
  try {
    await client.query("BEGIN");
    const result = await client.query<ResearchRunRow>(`
      UPDATE strategy_research_runs
      SET status = 'queued',
          stage = 'requirements',
          attempts = 0,
          brief_json = brief_json || $3::jsonb,
          result_json = COALESCE(result_json, '{}'::jsonb) - 'requirements',
          last_error_code = NULL,
          last_error_message = NULL,
          event_sequence = event_sequence + 1,
          updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status = 'awaiting_user_input'
        AND cancel_requested_at IS NULL
      RETURNING *
    `, [input.runId, input.ownerUserId, JSON.stringify(input.answers)]);
    if (!result.rows[0]) throw new Error("研发任务不存在、无需补充输入或已取消");
    await client.query(`
      INSERT INTO strategy_agent_events (id, run_id, sequence, role, event_type, title, content_json)
      VALUES ($1, $2, $3, 'requirements', 'input_received', '用户已补充研发条件', $4)
    `, [crypto.randomUUID(), input.runId, result.rows[0].event_sequence, { answeredFields: Object.keys(input.answers) }]);
    await client.query("COMMIT");
    return runFromRow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (release) client.release();
  }
}

const modeBudgets: Record<ResearchMode, { candidates: number; backtests: number; modelCalls: number }> = {
  quick: { candidates: 3, backtests: 12, modelCalls: 14 },
  standard: { candidates: 6, backtests: 60, modelCalls: 24 },
  deep: { candidates: 10, backtests: 200, modelCalls: 32 },
};

export async function createResearchRun(database: Queryable, input: {
  ownerUserId: string;
  conversationId: string;
  exchangeAccountId: string;
  mode: ResearchMode;
  brief: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const budget = modeBudgets[input.mode];
  if (!budget) throw new Error("不支持的研发模式");
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
    throw new Error("幂等键长度必须在 8 到 128 个字符之间");
  }
  const result = await database.query<ResearchRunRow>(`
    INSERT INTO strategy_research_runs (
      id, owner_user_id, conversation_id, exchange_account_id, mode, stage,
      brief_json, idempotency_key, candidate_budget, backtest_budget, model_call_budget
    ) VALUES ($1, $2, $3, $4, $5, 'requirements', $6, $7, $8, $9, $10)
    ON CONFLICT (owner_user_id, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING *
  `, [
    crypto.randomUUID(),
    input.ownerUserId,
    input.conversationId,
    input.exchangeAccountId,
    input.mode,
    input.brief,
    input.idempotencyKey,
    budget.candidates,
    budget.backtests,
    budget.modelCalls,
  ]);
  return runFromRow(result.rows[0]);
}

export async function leaseNextResearchRun(database: Queryable, input: {
  workerId: string;
  now: Date;
  leaseSeconds: number;
}) {
  if (!input.workerId.trim() || input.workerId.length > 120) throw new Error("Worker ID 无效");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) {
    throw new Error("任务租约必须在 5 到 300 秒之间");
  }
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
  const result = await database.query<ResearchRunRow>(`
    WITH picked AS (
      SELECT id
      FROM strategy_research_runs
      WHERE cancel_requested_at IS NULL
        AND attempts < max_retries
        AND (
          status = 'queued'
          OR (status = 'retry_wait' AND next_attempt_at <= $1)
          OR (status = 'running' AND lease_expires_at <= $1)
        )
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE strategy_research_runs AS run
    SET status = 'running',
        lease_owner = $2,
        lease_expires_at = $3,
        attempts = run.attempts + 1,
        started_at = COALESCE(run.started_at, $1),
        updated_at = $1
    FROM picked
    WHERE run.id = picked.id
    RETURNING run.*
  `, [input.now, input.workerId, leaseExpiresAt]);
  return result.rows[0] ? runFromRow(result.rows[0]) : null;
}

export async function renewResearchRunLease(database: Queryable, input: {
  runId: string;
  workerId: string;
  now: Date;
  leaseSeconds: number;
}) {
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) {
    throw new Error("任务租约必须在 5 到 300 秒之间");
  }
  const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
  const result = await database.query(`
    UPDATE strategy_research_runs
    SET lease_expires_at = $3, updated_at = $4
    WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      AND cancel_requested_at IS NULL AND lease_expires_at >= $4
    RETURNING id
  `, [input.runId, input.workerId, expiresAt, input.now]);
  if (!result.rows[0]) throw new Error("任务租约已失效或任务已取消");
  return expiresAt;
}

export async function requestResearchRunCancellation(database: Queryable, input: {
  runId: string;
  ownerUserId: string;
  now: Date;
}) {
  const result = await database.query<ResearchRunRow>(`
    UPDATE strategy_research_runs
    SET cancel_requested_at = CASE
          WHEN status IN ('completed', 'failed', 'cancelled') THEN cancel_requested_at
          ELSE COALESCE(cancel_requested_at, $3)
        END,
        status = CASE
          WHEN status NOT IN ('completed', 'failed', 'cancelled') THEN 'cancelled'
          ELSE status
        END,
        completed_at = CASE
          WHEN status NOT IN ('completed', 'failed', 'cancelled') THEN $3
          ELSE completed_at
        END,
        lease_owner = CASE
          WHEN status NOT IN ('completed', 'failed', 'cancelled') THEN NULL
          ELSE lease_owner
        END,
        lease_expires_at = CASE
          WHEN status NOT IN ('completed', 'failed', 'cancelled') THEN NULL
          ELSE lease_expires_at
        END,
        updated_at = $3
    WHERE id = $1 AND owner_user_id = $2
    RETURNING *
  `, [input.runId, input.ownerUserId, input.now]);
  if (!result.rows[0]) throw new Error("研发任务不存在");
  return runFromRow(result.rows[0]);
}

async function poolClient(database: Pool | PoolClient): Promise<{ client: PoolClient; release: boolean }> {
  if ("totalCount" in database) return { client: await database.connect(), release: true };
  return { client: database as PoolClient, release: false };
}

export async function appendResearchEvent(database: Pool | PoolClient, input: {
  runId: string;
  role: string;
  type: string;
  title: string;
  content: Record<string, unknown>;
}) {
  const { client, release } = await poolClient(database);
  try {
    await client.query("BEGIN");
    const sequenceResult = await client.query<{ event_sequence: string }>(`
      UPDATE strategy_research_runs
      SET event_sequence = event_sequence + 1, updated_at = now()
      WHERE id = $1
      RETURNING event_sequence
    `, [input.runId]);
    if (!sequenceResult.rows[0]) throw new Error("研发任务不存在");
    const sequence = Number(sequenceResult.rows[0].event_sequence);
    const eventResult = await client.query<{
      id: string;
      sequence: string;
      role: string;
      event_type: string;
      title: string;
      content_json: Record<string, unknown>;
      created_at: Date;
    }>(`
      INSERT INTO strategy_agent_events (
        id, run_id, sequence, role, event_type, title, content_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [crypto.randomUUID(), input.runId, sequence, input.role, input.type, input.title, input.content]);
    await client.query("COMMIT");
    const row = eventResult.rows[0];
    return {
      id: row.id,
      sequence: Number(row.sequence),
      role: row.role,
      type: row.event_type,
      title: row.title,
      content: row.content_json,
      createdAt: row.created_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (release) client.release();
  }
}

export async function advanceResearchRun(database: Pool | PoolClient, input: {
  runId: string;
  workerId: string;
  completedStage: string;
  now: Date;
  event: {
    role: string;
    type: string;
    title: string;
    content: Record<string, unknown>;
  };
}) {
  const nextStage = nextResearchStage(input.completedStage);
  if (nextStage === "completed") throw new Error("报告阶段必须通过确定性准入函数完成");
  const { client, release } = await poolClient(database);
  try {
    await client.query("BEGIN");
    const runResult = await client.query<ResearchRunRow & { event_sequence: string }>(`
      UPDATE strategy_research_runs
      SET stage = $4,
          progress = $5,
          status = 'queued',
          attempts = 0,
          lease_owner = NULL,
          lease_expires_at = NULL,
          event_sequence = event_sequence + 1,
          updated_at = $3
      WHERE id = $1
        AND lease_owner = $2
        AND lease_expires_at >= $3
        AND status = 'running'
        AND stage = $6
        AND cancel_requested_at IS NULL
      RETURNING *
    `, [
      input.runId,
      input.workerId,
      input.now,
      nextStage,
      researchStageProgress(nextStage),
      input.completedStage,
    ]);
    if (!runResult.rows[0]) throw new Error("任务租约已失效、阶段不匹配或任务已取消");
    const sequence = Number(runResult.rows[0].event_sequence);
    const eventResult = await client.query<{
      id: string;
      sequence: string;
      role: string;
      event_type: string;
      title: string;
      content_json: Record<string, unknown>;
      created_at: Date;
    }>(`
      INSERT INTO strategy_agent_events (
        id, run_id, sequence, role, event_type, title, content_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      crypto.randomUUID(),
      input.runId,
      sequence,
      input.event.role,
      input.event.type,
      input.event.title,
      input.event.content,
    ]);
    await client.query("COMMIT");
    const event = eventResult.rows[0];
    return {
      run: runFromRow(runResult.rows[0]),
      event: {
        id: event.id,
        sequence: Number(event.sequence),
        role: event.role,
        type: event.event_type,
        title: event.title,
        content: event.content_json,
        createdAt: event.created_at,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (release) client.release();
  }
}
