-- Prompt 配置的运行时消费与任务固定（T3.1c-PS2，PS-05）。
--
-- PS-05：激活与回滚只影响**随后创建**的新任务。已排队、执行中和历史任务继续用当初
-- 固定的那一版。中途替换会同时破坏重放、证据链、结果归因和事故复盘——一份历史解释
-- 说不清自己当时用的是哪份 Prompt，就等于没有解释。

-- 任务上的固定：配置版本 ID + payload 摘要。
--
-- 允许为空，且空**不是**「未知」而是「这份任务用的是代码内定义的 Prompt」。当前没有
-- 任何 Prompt 配置被激活过，全部任务都走代码定义；把它编成一个假的配置版本会让
-- 「这份解释依据哪份 Prompt」得到一个看似确定的错误答案（INV-6）。
ALTER TABLE strategy_runtime_explanation_jobs
  ADD COLUMN IF NOT EXISTS prompt_configuration_version_id text
    REFERENCES configuration_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS prompt_payload_sha256 text;

DO $$
BEGIN
  -- 两列必须同时有值或同时为空。只有版本 ID 没有摘要，就无法在执行时发现 payload
  -- 被改写；只有摘要没有版本 ID，则根本不知道该去核对哪一版。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'strategy_runtime_explanation_jobs_prompt_pin_check'
  ) THEN
    ALTER TABLE strategy_runtime_explanation_jobs
      ADD CONSTRAINT strategy_runtime_explanation_jobs_prompt_pin_check CHECK (
        (prompt_configuration_version_id IS NULL AND prompt_payload_sha256 IS NULL)
        OR (prompt_configuration_version_id IS NOT NULL
            AND prompt_payload_sha256 ~ '^[a-f0-9]{64}$')
      );
  END IF;
END $$;

COMMENT ON COLUMN strategy_runtime_explanation_jobs.prompt_configuration_version_id IS
  'Configuration version pinned when the job was enqueued (PS-05). NULL means the job uses the code-defined prompt, not that the version is unknown.';

-- 研发运行上的固定。
--
-- 研发不是一次调用而是一串步骤（需求整理 → 行情识别 → 提案 → 反方 → 风控 → 报告）。
-- 固定必须落在**运行**上而不是每个步骤上：否则第 3 步和第 4 步之间发生一次激活，同一
-- 次研发的前后半段会用两份不同的 Prompt，结论无法归因到任何一版。
--
-- 与既有的 agent_role_snapshot_json 同一形状——那一列固定的是模型修订，这一列固定的是
-- Prompt 配置版本，两者都在运行创建时拍下。
ALTER TABLE strategy_research_runs
  ADD COLUMN IF NOT EXISTS prompt_configuration_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'strategy_research_runs_prompt_snapshot_check'
  ) THEN
    ALTER TABLE strategy_research_runs
      ADD CONSTRAINT strategy_research_runs_prompt_snapshot_check CHECK (
        jsonb_typeof(prompt_configuration_snapshot_json) = 'object'
        AND octet_length(prompt_configuration_snapshot_json::text) <= 8192
      );
  END IF;
END $$;

COMMENT ON COLUMN strategy_research_runs.prompt_configuration_snapshot_json IS
  'Prompt configuration versions pinned when the run was created (PS-05), keyed by research role. An empty object means the run uses code-defined prompts.';

-- 入队时读「当前生效版本」的最小权限网关。与 0071 / 0077 同形状。
CREATE OR REPLACE FUNCTION prompt_configuration_active(
  p_configuration_key text
) RETURNS TABLE(
  configuration_version_id text,
  schema_version integer,
  payload_json jsonb,
  payload_sha256 text
) AS $$
  SELECT version.id,version.schema_version,version.payload_json,version.payload_sha256
    FROM configuration_activations AS activation
    JOIN configuration_versions AS version ON version.id=activation.configuration_version_id
   WHERE version.kind='prompt'
     AND version.configuration_key=p_configuration_key
     AND version.audience='shared'
   ORDER BY activation.sequence_no DESC
   LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT;

-- 执行时按**版本 ID**读某一份历史版本。
--
-- 这是与既有网关不同的一件事：0071 和 0077 都只返回当前生效版本，而 PS-05 恰恰要求
-- 读一份可能早已被替换掉的版本。
--
-- `EXISTS (configuration_activations ...)` 不是多余的：没有它，任何能写任务行的路径都
-- 可以把任务指向一份**从未获批**的草稿，然后让 Worker 照着它调模型——审批流程就被
-- 绕过了。只有曾经真正激活过的版本才可被固定，回滚之后仍可读（那正是 PS-05 要的），
-- 但从未上线过的草稿一律读不到。
CREATE OR REPLACE FUNCTION prompt_configuration_pinned(
  p_configuration_version_id text
) RETURNS TABLE(
  configuration_version_id text,
  configuration_key text,
  schema_version integer,
  payload_json jsonb,
  payload_sha256 text
) AS $$
  SELECT version.id,version.configuration_key,version.schema_version,
         version.payload_json,version.payload_sha256
    FROM configuration_versions AS version
   WHERE version.id=p_configuration_version_id
     AND version.kind='prompt'
     AND version.audience='shared'
     AND EXISTS (
       SELECT 1 FROM configuration_activations AS activation
        WHERE activation.configuration_version_id=version.id
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT;

COMMENT ON FUNCTION prompt_configuration_pinned(text) IS
  'Reads one historical prompt configuration version by id for PS-05 task pinning. Only versions that were activated at least once are readable, so a task cannot pin an unapproved draft.';

REVOKE ALL ON FUNCTION prompt_configuration_active(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION prompt_configuration_pinned(text) FROM PUBLIC;

DO $$
BEGIN
  -- Runtime Worker 入队并执行解释任务，两个网关都要。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_runtime_worker') THEN
    GRANT EXECUTE ON FUNCTION prompt_configuration_active(text) TO agentnovas_runtime_worker;
    GRANT EXECUTE ON FUNCTION prompt_configuration_pinned(text) TO agentnovas_runtime_worker;
  END IF;
  -- Research Worker 走同一套 Prompt 配置族。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_research_worker') THEN
    GRANT EXECUTE ON FUNCTION prompt_configuration_active(text) TO agentnovas_research_worker;
    GRANT EXECUTE ON FUNCTION prompt_configuration_pinned(text) TO agentnovas_research_worker;
  END IF;
  -- 运维端排查「这份解释当时用的是哪版 Prompt」需要按版本 ID 回读。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT EXECUTE ON FUNCTION prompt_configuration_pinned(text) TO agentnovas_maint_web;
  END IF;
END $$;
