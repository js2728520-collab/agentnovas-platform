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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const modeBudgets: Record<ResearchMode, { candidates: number; backtests: number }> = {
  quick: { candidates: 3, backtests: 12 },
  standard: { candidates: 6, backtests: 60 },
  deep: { candidates: 10, backtests: 200 },
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
      brief_json, idempotency_key, candidate_budget, backtest_budget
    ) VALUES ($1, $2, $3, $4, $5, 'requirements', $6, $7, $8, $9)
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

export async function requestResearchRunCancellation(database: Queryable, input: {
  runId: string;
  ownerUserId: string;
  now: Date;
}) {
  const result = await database.query<ResearchRunRow>(`
    UPDATE strategy_research_runs
    SET cancel_requested_at = COALESCE(cancel_requested_at, $3),
        status = CASE
          WHEN status IN ('queued', 'retry_wait', 'paused_missing_role') THEN 'cancelled'
          ELSE status
        END,
        completed_at = CASE
          WHEN status IN ('queued', 'retry_wait', 'paused_missing_role') THEN $3
          ELSE completed_at
        END,
        updated_at = $3
    WHERE id = $1 AND owner_user_id = $2
    RETURNING *
  `, [input.runId, input.ownerUserId, input.now]);
  if (!result.rows[0]) throw new Error("研发任务不存在");
  return runFromRow(result.rows[0]);
}

async function poolClient(database: Pool | PoolClient) {
  if ("connect" in database) return { client: await database.connect(), release: true };
  return { client: database, release: false };
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
