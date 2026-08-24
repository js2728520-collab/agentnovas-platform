-- 跟单周结算单（T4.3b / P-06）。
--
-- 与官方卡的 performance_fee_statements 同一形状，差别只有两处（需求方确认）：费率取自
-- 跟单合同的快照而不是当前费率；高水位线按 (客户, 策略) 各自一条而不是按客户合并。

CREATE TABLE IF NOT EXISTS strategy_follow_settlements (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES strategy_follow_contracts(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  strategy_id text NOT NULL REFERENCES community_strategies(id) ON DELETE RESTRICT,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  week_start timestamptz NOT NULL,
  week_end timestamptz NOT NULL,
  week_net_pnl numeric(36,18) NOT NULL,
  cumulative_net_pnl numeric(36,18) NOT NULL,
  prior_high_water_mark numeric(36,18) NOT NULL,
  next_high_water_mark numeric(36,18) NOT NULL,
  eligible_profit numeric(36,18) NOT NULL CHECK (eligible_profit >= 0),
  loss_carry numeric(36,18) NOT NULL CHECK (loss_carry >= 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  fee_amount numeric(36,18) NOT NULL CHECK (fee_amount >= 0),
  platform_amount numeric(36,18) NOT NULL CHECK (platform_amount >= 0),
  author_amount numeric(36,18) NOT NULL CHECK (author_amount >= 0),
  currency text NOT NULL DEFAULT 'USDT' CHECK (currency = 'USDT'),
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN (
    'no_fee','pending_review','approved','rejected','payment_pending','paid'
  )),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  replaces_settlement_id text REFERENCES strategy_follow_settlements(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (week_end = week_start + interval '7 days'),
  -- 高水位线只升不降。降下来会让同一段涨幅被收两次费（INV-5）。
  CHECK (next_high_water_mark >= prior_high_water_mark),
  -- **分账守恒写进数据库**，不只靠应用层那个函数。两边各自取整漏出的尾差会在这里被
  -- 挡住，而账本要求借贷必平（INV-4）。
  CHECK (platform_amount + author_amount = fee_amount),
  -- 同一份合同、同一周、同一修订号只有一张单。重算走新 revision，不覆盖。
  UNIQUE (contract_id, week_start, revision)
);

CREATE INDEX IF NOT EXISTS idx_strategy_follow_settlements_author
  ON strategy_follow_settlements (author_user_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_follow_settlements_customer
  ON strategy_follow_settlements (customer_id, week_start DESC);

-- 金额列不可改写；状态可以流转。
--
-- 结算单是「这一周向客户收了多少、其中多少归作者」的记录。能改金额就能在事后调整已经
-- 出过的账，而下游的账本分录已经按原值记过了。算错了走新 revision（P-06：结算前的计算
-- 错误通过重算修正），不是就地改。
CREATE OR REPLACE FUNCTION protect_strategy_follow_settlement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FOLLOW_SETTLEMENT_IMMUTABLE';
  END IF;
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.week_start IS DISTINCT FROM OLD.week_start
    OR NEW.week_net_pnl IS DISTINCT FROM OLD.week_net_pnl
    OR NEW.cumulative_net_pnl IS DISTINCT FROM OLD.cumulative_net_pnl
    OR NEW.prior_high_water_mark IS DISTINCT FROM OLD.prior_high_water_mark
    OR NEW.next_high_water_mark IS DISTINCT FROM OLD.next_high_water_mark
    OR NEW.eligible_profit IS DISTINCT FROM OLD.eligible_profit
    OR NEW.fee_bps IS DISTINCT FROM OLD.fee_bps
    OR NEW.fee_amount IS DISTINCT FROM OLD.fee_amount
    OR NEW.platform_amount IS DISTINCT FROM OLD.platform_amount
    OR NEW.author_amount IS DISTINCT FROM OLD.author_amount THEN
    RAISE EXCEPTION 'FOLLOW_SETTLEMENT_AMOUNTS_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_strategy_follow_settlement_immutable ON strategy_follow_settlements;
CREATE TRIGGER trg_strategy_follow_settlement_immutable
  BEFORE UPDATE OR DELETE ON strategy_follow_settlements
  FOR EACH ROW EXECUTE FUNCTION protect_strategy_follow_settlement();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT SELECT ON strategy_follow_settlements TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT ON strategy_follow_settlements TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON strategy_follow_settlements TO agentnovas_maint_web;
  END IF;
END $$;
