-- 解释任务按决策轮建，不再按部署周期建（ADR-0018 第 2 步）。
--
-- 背景：strategy_runtime_explanation_jobs 原本按 cycle_id 建，触发条件是
-- 「动作不是 hold，或风控拒绝」。官方现货是「每个 (客户, 策略卡) 一个部署」，
-- 5,000 会员 × 3 张卡 = 15,000 个周期——某张卡一旦产生信号，15,000 个周期各自
-- 发起 LLM 解释，同一段解释被生成上万次。
--
-- 同一张卡在同一根 K 线上的解释内容完全相同（它解释的是卡级结论，不含任何
-- 客户数据），所以每轮每角色只需要一次调用，结果扇出写回该轮下所有周期的事件。
--
-- 迁移只加列与约束，不改变已有行；写入路径的切换在 lib/ 里。

ALTER TABLE strategy_runtime_explanation_jobs
  ADD COLUMN IF NOT EXISTS decision_round_id text
    REFERENCES strategy_decision_rounds(id) ON DELETE CASCADE;

-- 每轮每角色只允许一个任务。用部分唯一索引而不是表约束：永续部署没有决策轮，
-- decision_round_id 为 NULL，那些行继续只受 UNIQUE (cycle_id, event_role) 约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_explanation_jobs_round_role
  ON strategy_runtime_explanation_jobs (decision_round_id, event_role)
  WHERE decision_round_id IS NOT NULL;

-- 写回时按 (decision_round_id, role) 找事件，需要这条索引。
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_events_round_role
  ON strategy_runtime_events (decision_round_id, role)
  WHERE decision_round_id IS NOT NULL;
