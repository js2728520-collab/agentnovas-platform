-- 决策轮共享化：同一张策略卡、同一品种、同一根已收盘 K 线只算一次。
--
-- 背景：官方现货的运行粒度是「每个 (客户, 策略卡) 一个部署」。按目标规模
-- （5,000 会员 × 3 张卡）会有 15,000 个部署，各自跑决策周期——而三张卡合计
-- 只有 6 种 (品种, 周期) 组合。同一份判断被重复计算 2,500 次。
--
-- 最贵的不是计算，是解释：strategy_runtime_explanation_jobs 按 cycle_id 建，
-- 触发条件是「动作不是 hold，或风控拒绝」。某张卡一旦产生信号，15,000 个周期
-- 各自发起 LLM 解释，同一段解释被生成上万次。
--
-- 决策见 docs/adr/0018-shared-decision-rounds-and-per-portfolio-admission.md：
-- 决策共享，准入按组合。本迁移只建表并允许双写，不改变任何读取路径。

CREATE TABLE IF NOT EXISTS strategy_decision_rounds (
  id text PRIMARY KEY,
  strategy_code text NOT NULL CHECK (strategy_code IN ('ai_conservative', 'ai_balanced', 'ai_aggressive')),
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  timeframe text NOT NULL CHECK (timeframe IN ('5m', '15m', '1h', '4h', '1d')),
  strategy_version_id text NOT NULL,
  candle_open_time timestamptz NOT NULL,
  candle_close_time timestamptz NOT NULL,
  market_data_snapshot_id text,
  -- 卡级结论：action / reason / riskApproved / 卡级 rejectionReasons。
  -- 组合级的准入结果不在这里，见 strategy_runtime_cycles.decision_round_id。
  decision_json jsonb NOT NULL,
  -- 目标仓位比例，不含绝对数量——数量在扇出时按各组合资金换算
  -- （packages/domain/src/execution/execution-port.ts 的 resolveOrderQuantity）。
  order_intent_json jsonb,
  trace_id text NOT NULL,
  completeness text NOT NULL DEFAULT 'complete'
    CHECK (completeness IN ('complete', 'partial', 'legacy')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- INV-8：相同 card/candle/contract 的重试必须落在同一行。
  UNIQUE (strategy_code, symbol, timeframe, candle_close_time)
);

CREATE INDEX IF NOT EXISTS idx_strategy_decision_rounds_lookup
  ON strategy_decision_rounds (strategy_code, symbol, timeframe, candle_close_time DESC);

-- 部署周期变为「该部署在该决策轮上的准入结果」。
-- 可空是过渡期需要：ADR 的第 1 步是双写，旧写入路径仍会产生没有决策轮的周期行。
ALTER TABLE strategy_runtime_cycles
  ADD COLUMN IF NOT EXISTS decision_round_id text
    REFERENCES strategy_decision_rounds(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_strategy_runtime_cycles_decision_round
  ON strategy_runtime_cycles (decision_round_id)
  WHERE decision_round_id IS NOT NULL;

-- 七阶段事件与解释任务最终会挂到决策轮上（ADR 第 2 步）。这里先加可空列，
-- 让写入路径可以同时填两边，读取路径不变。
ALTER TABLE strategy_runtime_events
  ADD COLUMN IF NOT EXISTS decision_round_id text
    REFERENCES strategy_decision_rounds(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_strategy_runtime_events_decision_round
  ON strategy_runtime_events (decision_round_id, sequence)
  WHERE decision_round_id IS NOT NULL;
