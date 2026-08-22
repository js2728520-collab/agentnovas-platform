import type { Pool, PoolClient } from "pg";

import { canonicalJsonSha256 } from "../packages/domain/src/canonical-hash.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

type StepRow<T> = {
  status: "running" | "completed" | "failed";
  input_sha256: string;
  output_json: T | null;
};

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : "步骤执行失败";
  return message.replace(/sk-[a-z0-9_-]+/gi, "[REDACTED]").slice(0, 500);
}

export async function runCheckpointedResearchStep<T extends {
  modelName?: string;
  promptVersion?: string;
  promptHash?: string;
}>(database: Queryable, options: {
  runId: string;
  stage: string;
  stepKey: string;
  input: unknown;
  modelProfileId?: string;
  modelRevisionId?: string;
  execute: () => Promise<T>;
}) {
  if (!options.runId || !options.stage || !options.stepKey || options.stepKey.length > 160) {
    throw new Error("研发步骤标识无效");
  }
  const inputSha256 = await canonicalJsonSha256(options.input);
  const load = () => database.query<StepRow<T>>(`
    SELECT status, input_sha256, output_json
    FROM strategy_research_steps
    WHERE run_id = $1 AND step_key = $2
  `, [options.runId, options.stepKey]);
  const existing = (await load()).rows[0];
  if (existing?.input_sha256 !== undefined && existing.input_sha256 !== inputSha256) {
    throw new Error("研发步骤输入哈希与已有检查点不一致");
  }
  if (existing?.status === "completed") {
    if (existing.output_json === null) throw new Error("已完成研发步骤缺少输出");
    return existing.output_json;
  }

  const claimed = await database.query(`
    INSERT INTO strategy_research_steps (
      id, run_id, stage, step_key, status, input_sha256,
      model_profile_id, model_revision_id
    ) VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)
    ON CONFLICT (run_id, step_key) DO UPDATE SET
      status = 'running',
      attempt_count = strategy_research_steps.attempt_count + 1,
      started_at = now(),
      completed_at = NULL,
      last_error_code = NULL,
      last_error_message = NULL
    WHERE strategy_research_steps.status <> 'completed'
      AND strategy_research_steps.input_sha256 = EXCLUDED.input_sha256
    RETURNING id
  `, [
    crypto.randomUUID(),
    options.runId,
    options.stage,
    options.stepKey,
    inputSha256,
    options.modelProfileId ?? null,
    options.modelRevisionId ?? null,
  ]);
  if (!claimed.rows[0]) {
    const completed = (await load()).rows[0];
    if (completed?.status === "completed" && completed.output_json !== null) return completed.output_json;
    throw new Error("研发步骤检查点冲突");
  }

  try {
    const value = await options.execute();
    if (value.promptHash && !/^[a-f0-9]{64}$/.test(value.promptHash)) throw new Error("Prompt 哈希格式无效");
    const result = await database.query(`
      UPDATE strategy_research_steps
      SET status = 'completed', output_json = $4::jsonb,
          model_name = $5, prompt_version = $6, prompt_sha256 = $7,
          completed_at = now(), last_error_code = NULL, last_error_message = NULL
      WHERE run_id = $1 AND step_key = $2 AND input_sha256 = $3 AND status = 'running'
      RETURNING id
    `, [
      options.runId,
      options.stepKey,
      inputSha256,
      JSON.stringify(value),
      value.modelName ?? null,
      value.promptVersion ?? null,
      value.promptHash ?? null,
    ]);
    if (!result.rows[0]) throw new Error("研发步骤完成写入冲突");
    return value;
  } catch (error) {
    await database.query(`
      UPDATE strategy_research_steps
      SET status = 'failed', last_error_code = 'STEP_FAILED',
          last_error_message = $4, completed_at = now()
      WHERE run_id = $1 AND step_key = $2 AND input_sha256 = $3
    `, [options.runId, options.stepKey, inputSha256, publicError(error)]);
    throw error;
  }
}
