-- 社区策略跟单的模拟成交账本（T4.4 第 1 步）。
--
-- 与官方卡的三张表（official_paper_positions / _order_intents / _fill_receipts）形状一致，
-- 但**不复用**它们：那三张表的 symbol 被 CHECK 限定为三个官方品种，portfolio_id 外键指向
-- official_paper_portfolios。为了塞进社区策略而放宽，等于让「这是不是官方卡」不再能从
-- 数据判断。
--
-- 记账逻辑本身是**共用**的（packages/domain/src/official-paper-portfolio.ts）——表可以分开，
-- 算法不能分开，否则两边的盈亏口径迟早分叉，而盈亏是绩效分成的计算基础（INV-5）。

CREATE TABLE IF NOT EXISTS strategy_follow_paper_positions (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL REFERENCES strategy_follow_paper_portfolios(id) ON DELETE CASCADE,
  -- 没有 symbol 白名单：社区策略交易什么由它自己的 DSL 决定，可交易范围由跟单合同的
  -- 记账合同在域层把关（followPaperBookContract）。在这里再写死一份会与合同冲突。
  symbol text NOT NULL CHECK (length(btrim(symbol)) > 0),
  side text NOT NULL DEFAULT 'long' CHECK (side = 'long'),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  average_entry_price numeric(30, 12) NOT NULL CHECK (average_entry_price > 0),
  cost_basis_usdt numeric(30, 12) NOT NULL CHECK (cost_basis_usdt > 0),
  entry_fees_usdt numeric(30, 12) NOT NULL DEFAULT 0 CHECK (entry_fees_usdt >= 0),
  realized_gross_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  realized_net_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  -- 一个组合在同一品种上只有一个未平仓位。允许两个会让「这个策略现在持有多少」有两个答案。
  CONSTRAINT strategy_follow_paper_positions_closed_check CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_follow_paper_open_position
  ON strategy_follow_paper_positions (portfolio_id, symbol) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS strategy_follow_paper_order_intents (
  id text PRIMARY KEY,
  portfolio_id text NOT NULL REFERENCES strategy_follow_paper_portfolios(id) ON DELETE CASCADE,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE CASCADE,
  runtime_cycle_id text NOT NULL REFERENCES strategy_runtime_cycles(id) ON DELETE CASCADE,
  -- 幂等键。同一决策轮重跑必须落在同一行上，否则一次决策会记两笔成交。
  idempotency_key text NOT NULL UNIQUE,
  symbol text NOT NULL CHECK (length(btrim(symbol)) > 0),
  action text NOT NULL CHECK (action IN ('buy', 'sell')),
  execution_timing text NOT NULL CHECK (execution_timing IN ('next_candle_open', 'intrabar_threshold')),
  requested_price numeric(30, 12),
  status text NOT NULL CHECK (status IN ('shadowed', 'pending', 'filled', 'rejected', 'cancelled')),
  rejection_code text,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  filled_at timestamptz,
  CONSTRAINT strategy_follow_paper_intents_filled_check CHECK (
    (status = 'filled') = (filled_at IS NOT NULL)
  ),
  -- 被拒必须说明原因。没有原因的拒绝，事后分不清是风控挡的还是代码出错。
  CONSTRAINT strategy_follow_paper_intents_rejection_check CHECK (
    (status = 'rejected') = (rejection_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_strategy_follow_paper_intents_pending
  ON strategy_follow_paper_order_intents (deployment_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS strategy_follow_paper_fill_receipts (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES strategy_follow_paper_order_intents(id) ON DELETE CASCADE,
  portfolio_id text NOT NULL REFERENCES strategy_follow_paper_portfolios(id) ON DELETE CASCADE,
  position_id text REFERENCES strategy_follow_paper_positions(id),
  symbol text NOT NULL CHECK (length(btrim(symbol)) > 0),
  action text NOT NULL CHECK (action IN ('buy', 'sell')),
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  fill_price numeric(30, 12) NOT NULL CHECK (fill_price > 0),
  notional_usdt numeric(30, 12) NOT NULL CHECK (notional_usdt > 0),
  fee_usdt numeric(30, 12) NOT NULL CHECK (fee_usdt >= 0),
  allocated_entry_fee_usdt numeric(30, 12) NOT NULL DEFAULT 0 CHECK (allocated_entry_fee_usdt >= 0),
  realized_gross_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  realized_net_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  filled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 一个意图只成交一次。
  UNIQUE (intent_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_follow_paper_receipts_portfolio
  ON strategy_follow_paper_fill_receipts (portfolio_id, filled_at, id);

-- 成交回执 append-only。
--
-- 与官方卡同理：回执是客户模拟盘盈亏的原始事实，也是周结算的输入。能改写它就能事后
-- 调整一个客户的已实现盈亏，而绩效分成正是按它算的（INV-5）。
CREATE OR REPLACE FUNCTION protect_follow_paper_fill_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FOLLOW_PAPER_RECEIPT_APPEND_ONLY';
END $$;

DROP TRIGGER IF EXISTS trg_follow_paper_receipt_append_only ON strategy_follow_paper_fill_receipts;
CREATE TRIGGER trg_follow_paper_receipt_append_only
  BEFORE UPDATE OR DELETE ON strategy_follow_paper_fill_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_follow_paper_fill_receipt();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_runtime_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON strategy_follow_paper_positions TO agentnovas_runtime_worker;
    GRANT SELECT, INSERT, UPDATE ON strategy_follow_paper_order_intents TO agentnovas_runtime_worker;
    GRANT SELECT, INSERT ON strategy_follow_paper_fill_receipts TO agentnovas_runtime_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT ON strategy_follow_paper_positions TO agentnovas_client_web;
    GRANT SELECT ON strategy_follow_paper_order_intents TO agentnovas_client_web;
    GRANT SELECT ON strategy_follow_paper_fill_receipts TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT SELECT ON strategy_follow_paper_positions TO agentnovas_ops_web;
    GRANT SELECT ON strategy_follow_paper_fill_receipts TO agentnovas_ops_web;
  END IF;
END $$;
