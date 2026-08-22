-- 让「现货 + 真实交易所账户」这个形状可以被表达。
--
-- 此前的数据模型里没有它：mode 只允许 shadow/paper，而绑定约束要求
-- spot_usdt 的部署 exchange_account_id 必须为 NULL，只有 usdt_perpetual 才带账户
-- ——而永续是硬关闭的。于是「跑现货实盘」在库里根本无法登记。
--
-- 这就是 createLiveExecutionPort 长期没有调用方的根因之一：缺的不是一行调用，
-- 是数据模型里没有这件事。
--
-- 见 docs/adr/0019 第 6 步之后的续作。

ALTER TABLE strategy_deployments DROP CONSTRAINT IF EXISTS strategy_deployments_mode_check;
ALTER TABLE strategy_deployments
  ADD CONSTRAINT strategy_deployments_mode_check
  CHECK (mode IN ('shadow', 'paper', 'live'));

-- 现货实盘沿用 paper 的全部结构（组合、会员、策略卡），只多一个交易所账户。
--
-- 刻意不另起一套并行结构：paper 组合是绩效分成的计费基准与高水位线载体，
-- 让实盘走同一条记账路径，分成口径才不会分叉（INV-5）。实盘与 paper 的差别只应该
-- 是「订单同时也发到交易所」，不应该是「换了一套账」。
--
-- `(mode = 'live') = (exchange_account_id IS NOT NULL)` 是双向的：
--   - live 但没绑账户 → 拒绝。没有账户就无法下单，这种部署一旦被 Worker 取走会
--     每一轮都失败，而失败原因要到执行端才看得出来。
--   - 非 live 却绑了账户 → 拒绝。paper/shadow 挂着一个真实账户，是「以为在模拟、
--     其实随时可能真下单」的前置条件。
ALTER TABLE strategy_deployments DROP CONSTRAINT IF EXISTS strategy_deployments_official_binding_check;
ALTER TABLE strategy_deployments
  ADD CONSTRAINT strategy_deployments_official_binding_check
  CHECK (
    (
      execution_product = 'spot_usdt'
      AND paper_portfolio_id IS NOT NULL
      AND membership_id IS NOT NULL
      AND platform_strategy_code IS NOT NULL
      AND (mode = 'live') = (exchange_account_id IS NOT NULL)
    )
    OR (
      execution_product = 'usdt_perpetual'
      AND exchange_account_id IS NOT NULL
      AND paper_portfolio_id IS NULL
      AND membership_id IS NULL
      AND platform_strategy_code IS NULL
    )
  );

-- 一个账户在同一张策略卡上只能有一个生效中的实盘部署。
--
-- 没有它，同一个账户可以被两个部署同时驱动，两边各自开仓，客户的实际仓位是两份而
-- 风控按一份算。
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_deployments_live_account_card
  ON strategy_deployments (exchange_account_id, platform_strategy_code)
  WHERE mode = 'live' AND status = 'active';

-- 实盘部署下发的每一笔回执。
--
-- 与 execution_reconciliations 分工不同：那张表回答「这一单到底成没成」，
-- 这张表回答「这一轮决策在这个组合上产出了什么结果」，是客户能看到的执行证据，
-- 也是把决策轮与真实成交连起来的那一环（INV-8 可解释、可审计）。
CREATE TABLE IF NOT EXISTS live_execution_receipts (
  id text PRIMARY KEY,
  deployment_id text NOT NULL,
  customer_id text NOT NULL,
  exchange_account_id text NOT NULL,

  decision_round_id text NOT NULL,
  runtime_cycle_id text,
  intent_id text NOT NULL,
  client_order_id text,
  trace_id text,

  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  outcome text NOT NULL CHECK (outcome IN ('filled', 'partial', 'rejected', 'expired')),
  filled_quantity double precision NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  average_price double precision NOT NULL DEFAULT 0 CHECK (average_price >= 0),
  fee_amount double precision NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  rejection_reason text,
  external_order_id text,
  executed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- 同一条意图只能有一条回执。重放同一轮决策必须幂等（INV-8）。
  UNIQUE (intent_id),

  -- 被拒必须给出原因，成交必须有正的均价。
  -- 允许一条「成交了但价格为 0」的回执，等于允许一笔无法结算的成交进入分成计算。
  CONSTRAINT live_execution_receipts_rejected_has_reason
    CHECK (outcome NOT IN ('rejected', 'expired') OR rejection_reason IS NOT NULL),
  CONSTRAINT live_execution_receipts_filled_has_price
    CHECK (outcome NOT IN ('filled', 'partial') OR (filled_quantity > 0 AND average_price > 0))
);

CREATE INDEX IF NOT EXISTS idx_live_execution_receipts_deployment
  ON live_execution_receipts (deployment_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_execution_receipts_round
  ON live_execution_receipts (decision_round_id);

-- 回执不可改写：它是绩效分成的依据。
CREATE OR REPLACE FUNCTION enforce_live_execution_receipt_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '执行回执不可修改或删除（intent_id=%）', OLD.intent_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS live_execution_receipts_immutable ON live_execution_receipts;
CREATE TRIGGER live_execution_receipts_immutable
  BEFORE UPDATE OR DELETE ON live_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION enforce_live_execution_receipt_immutable();
