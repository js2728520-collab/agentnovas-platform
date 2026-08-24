-- 跟单合同快照与作者分账（T4.3 / P-06）。
--
-- INV-5：「历史订单保存计划版本与费率快照，改价不影响历史」。跟单同理，而且更硬：客户
-- 点「确认跟随」时看到的是某个策略版本、某个费率、某组风险参数——这三样构成他同意的
-- 那份合同。之后作者改版本、平台改费率、运营改门槛，都不能回头改写这份合同。
--
-- 此前 strategy_subscriptions 上只有 strategy_version_id，没有任何费率或风险快照：
-- 改一次费率就会静默改变所有存量跟随者的计费口径。

CREATE TABLE IF NOT EXISTS strategy_follow_contracts (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES strategy_subscriptions(id) ON DELETE RESTRICT,
  strategy_id text NOT NULL REFERENCES community_strategies(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- 跟的是哪一版。作者发新版不影响已经跟随的人，除非他们显式换版。
  strategy_version_id text NOT NULL,
  strategy_version integer NOT NULL,
  -- 费率快照。performance_fee_bps 取自客户当时的会员权益（需求方确认：用会员档位费率），
  -- 分账比例取自 P-06。三者一起决定这笔跟随以后怎么计费。
  performance_fee_bps integer NOT NULL CHECK (performance_fee_bps BETWEEN 0 AND 10000),
  platform_share_bps integer NOT NULL CHECK (platform_share_bps BETWEEN 0 AND 10000),
  subscription_fee_usdt numeric(36,18) NOT NULL DEFAULT 0 CHECK (subscription_fee_usdt >= 0),
  publication_mode text NOT NULL CHECK (publication_mode IN ('marketplace','self_use')),
  -- 风险参数快照。客户确认的是这组数字，不是「策略当前的设置」。
  risk_json jsonb NOT NULL CHECK (jsonb_typeof(risk_json) = 'object'),
  -- 客户确认跟随的时刻与他当时看到的披露版本。
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  disclosure_sha256 text NOT NULL CHECK (disclosure_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 一次订阅一份合同。换版本或换参数要结束旧订阅、建新的，而不是就地改。
  UNIQUE (subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_follow_contracts_strategy
  ON strategy_follow_contracts (strategy_id, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_follow_contracts_author
  ON strategy_follow_contracts (author_user_id, confirmed_at DESC);

-- 合同不可改写。
--
-- 这不是洁癖：合同是「客户当初同意了什么」的唯一记录。能改写它，就能在事后把一位客户
-- 的费率从 16% 改成 20%，而所有下游计算都会照着新值算，没有任何地方会报错。
CREATE OR REPLACE FUNCTION protect_strategy_follow_contract()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FOLLOW_CONTRACT_IMMUTABLE';
END $$;

DROP TRIGGER IF EXISTS trg_strategy_follow_contract_immutable ON strategy_follow_contracts;
CREATE TRIGGER trg_strategy_follow_contract_immutable
  BEFORE UPDATE OR DELETE ON strategy_follow_contracts
  FOR EACH ROW EXECUTE FUNCTION protect_strategy_follow_contract();

-- 下架不得改动既有订阅（T4.3 验收项）。
--
-- 「下架」是让策略不再对新客户可见，不是终止已有跟随。终止跟随会让客户在毫无通知的情况
-- 下失去持仓管理能力；真正要终止得走 strategy_change_requests 的 7 天通知缓冲期。
--
-- 表达方式是**让被禁止的事情无法被记录**，而不是拦住 UPDATE 本身：客户随时可以自己停止
-- 跟随，运营也可以按变更申请终止，这两条都必须畅通。真正要禁的只有一种理由——「因为策略
-- 下架了所以顺手把订阅结束掉」。因此结束订阅必须写明理由，而这个理由不在允许的取值里。
ALTER TABLE strategy_subscriptions
  ADD COLUMN IF NOT EXISTS ended_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_subscriptions_ended_reason_check') THEN
    ALTER TABLE strategy_subscriptions
      ADD CONSTRAINT strategy_subscriptions_ended_reason_check CHECK (
        ended_reason IS NULL OR ended_reason IN (
          'customer_stopped',      -- 客户自己停止
          'change_request',        -- 走完通知缓冲期的作者变更/下架申请
          'risk_blocked',          -- 风控或熔断终止
          'operations_terminated'  -- 运营依据事故或合规终止
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION protect_subscription_on_delisting()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('ended','cancelled')
    AND OLD.status IN ('active','paused','pending') THEN
    -- 结束跟随必须写明理由。没有理由的结束正是「下架时顺手改掉」的形态：没人知道是谁、
    -- 因为什么结束了客户的跟随。
    IF NEW.ended_reason IS NULL THEN
      RAISE EXCEPTION 'SUBSCRIPTION_END_REASON_REQUIRED';
    END IF;
    -- 作者变更/下架申请必须真的走完通知缓冲期，不能只是把理由填上。
    IF NEW.ended_reason = 'change_request' AND NOT EXISTS (
      SELECT 1 FROM strategy_change_requests
       WHERE strategy_id = NEW.strategy_id AND status = 'completed'
    ) THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHANGE_REQUEST_NOT_COMPLETED';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_subscription_delisting_guard ON strategy_subscriptions;
CREATE TRIGGER trg_subscription_delisting_guard
  BEFORE UPDATE ON strategy_subscriptions
  FOR EACH ROW EXECUTE FUNCTION protect_subscription_on_delisting();

-- 每（客户, 策略）一条高水位线（需求方确认）。
--
-- 与官方卡按客户合并的那条（performance_fee_high_water_marks）刻意不同：作者拿到的应该
-- 是自己策略真实创造的收益，不被客户跟的其它作者的亏损抵消——否则作者的收入取决于客户
-- 又跟了谁，他既无法控制也无法预期。
CREATE TABLE IF NOT EXISTS strategy_follow_high_water_marks (
  customer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  strategy_id text NOT NULL REFERENCES community_strategies(id) ON DELETE RESTRICT,
  cumulative_net_pnl numeric(36,18) NOT NULL DEFAULT 0,
  high_water_mark numeric(36,18) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, strategy_id)
);

-- 作者分账的争议与退款状态（T4.3 验收项）。
--
-- P-06：已结算的分成不退。因此 `disputed` 与 `reversed` 是两件事——前者是「有人提出
-- 异议，先冻住不付」，后者是「结算前发现算错了，用反向分录更正」。已付出去的不走这里，
-- 走既有的 revision 机制。
ALTER TABLE strategy_author_earnings
  ADD COLUMN IF NOT EXISTS dispute_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS dispute_reason text,
  ADD COLUMN IF NOT EXISTS dispute_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS period_week_start text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_author_earnings_dispute_check') THEN
    ALTER TABLE strategy_author_earnings
      ADD CONSTRAINT strategy_author_earnings_dispute_check CHECK (
        dispute_status IN ('none','opened','upheld','rejected')
        AND (dispute_status = 'none') = (dispute_opened_at IS NULL)
        AND (dispute_status IN ('upheld','rejected')) = (dispute_resolved_at IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN strategy_author_earnings.period_week_start IS
  'UTC week start for this earning (P-06 settlementCycle=utc_week). The legacy period_month column predates the frozen weekly cycle and must not be used for new settlements.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT, INSERT ON strategy_follow_contracts TO agentnovas_client_web;
    GRANT SELECT ON strategy_follow_high_water_marks TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT SELECT ON strategy_follow_contracts TO agentnovas_ops_web;
    GRANT SELECT ON strategy_follow_high_water_marks TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON strategy_follow_contracts TO agentnovas_maint_web;
  END IF;
END $$;
