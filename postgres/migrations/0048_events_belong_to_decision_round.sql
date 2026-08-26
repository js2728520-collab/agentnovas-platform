-- 七阶段叙述属于共享决策轮，不属于某个客户的周期（ADR-0018 第 4b 步）。
--
-- 背景：纯 hold 不为每个组合写周期行（已定的产品决策）。但 hold 的那一轮同样
-- 需要七阶段叙述——那正是客户看「为什么这一轮没有动作」的地方。
-- 事件原本要求 cycle_id NOT NULL，于是「没有周期就没有叙述」，把最该解释的
-- 那种情况解释没了。
--
-- 解决：事件与解释任务挂在决策轮上，cycle_id 变为可空。至少要有一个归属。

ALTER TABLE strategy_runtime_events ALTER COLUMN cycle_id DROP NOT NULL;
ALTER TABLE strategy_runtime_explanation_jobs ALTER COLUMN cycle_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_runtime_events_has_owner'
  ) THEN
    ALTER TABLE strategy_runtime_events
      ADD CONSTRAINT strategy_runtime_events_has_owner
      CHECK (cycle_id IS NOT NULL OR decision_round_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_runtime_explanation_jobs_has_owner'
  ) THEN
    ALTER TABLE strategy_runtime_explanation_jobs
      ADD CONSTRAINT strategy_runtime_explanation_jobs_has_owner
      CHECK (cycle_id IS NOT NULL OR decision_round_id IS NOT NULL);
  END IF;
END $$;

-- 原有的 UNIQUE (cycle_id, sequence) / (cycle_id, role) 在 cycle_id 为 NULL 时
-- 不起作用（Postgres 把 NULL 视为互不相同）。共享轮的去重改由这两条部分唯一
-- 索引保证：一轮七个阶段，每个 role 一行。
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_runtime_events_round_sequence
  ON strategy_runtime_events (decision_round_id, sequence)
  WHERE decision_round_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_runtime_events_round_unique_role
  ON strategy_runtime_events (decision_round_id, role)
  WHERE decision_round_id IS NOT NULL;
