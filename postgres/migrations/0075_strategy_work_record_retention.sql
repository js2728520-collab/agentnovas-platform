-- Client 工作记录需要按「客户实际持有策略的时间段」判断可见性，不能用当前订阅
-- 状态反推历史。一次订阅可以停止后再次启用，因此把每段生效区间独立留存。
CREATE TABLE IF NOT EXISTS strategy_subscription_periods (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES strategy_subscriptions(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE RESTRICT,
  strategy_code text NOT NULL CHECK (strategy_code IN ('ai_conservative', 'ai_balanced', 'ai_aggressive')),
  strategy_version_id text NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
  mode text NOT NULL CHECK (mode IN ('shadow', 'paper')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_subscription_periods_interval_check
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (deployment_id, started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_subscription_periods_open_subscription
  ON strategy_subscription_periods (subscription_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_subscription_periods_open_deployment
  ON strategy_subscription_periods (deployment_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_strategy_subscription_periods_customer_time
  ON strategy_subscription_periods (customer_id, started_at DESC, ended_at);
CREATE INDEX IF NOT EXISTS idx_strategy_subscription_periods_deployment_time
  ON strategy_subscription_periods (deployment_id, started_at DESC);

-- 列表/详情查询的热路径。没有这些索引，长期历史会把每一轮准入与意图检查退化为
-- 重复全表扫描；应用层另有 5 秒 statement_timeout 作为最后的可用性保护。
CREATE INDEX IF NOT EXISTS idx_strategy_decision_rounds_work_records
  ON strategy_decision_rounds (strategy_code, symbol, strategy_version_id, candle_close_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_cycles_work_records
  ON strategy_runtime_cycles (deployment_id, decision_round_id, completed_at DESC, id DESC)
  WHERE decision_round_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_official_paper_intents_runtime_cycle
  ON official_paper_order_intents (runtime_cycle_id, created_at, id);

-- legacy 时间是早期 text 列。拒绝带明确主键的脏数据，比隐式 cast 错误或悄悄跳过
-- 更安全：上线人员可以在迁移前修复真源，而不是得到一份缺历史的“成功”迁移。
CREATE OR REPLACE FUNCTION parse_strategy_work_record_legacy_timestamp(
  value text, field_name text, subscription_id text
) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN RETURN NULL; END IF;
  BEGIN
    RETURN value::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid legacy % timestamp for strategy subscription %', field_name, subscription_id;
  END;
END $$;

DO $$
DECLARE
  missing_deployment_id text;
BEGIN
  SELECT deployment.id INTO missing_deployment_id
  FROM strategy_deployments AS deployment
  JOIN strategy_subscriptions AS subscription ON subscription.id = deployment.strategy_subscription_id
  WHERE deployment.execution_product = 'spot_usdt'
    AND deployment.mode IN ('shadow', 'paper')
    AND NOT EXISTS (
      SELECT 1 FROM platform_strategy_migration_map AS migration
      WHERE migration.strategy_id = deployment.strategy_id
        AND migration.strategy_version_id = deployment.strategy_version_id
        AND migration.strategy_code = deployment.platform_strategy_code
    )
  LIMIT 1;
  IF missing_deployment_id IS NOT NULL THEN
    RAISE EXCEPTION 'strategy work record backfill missing migration map for deployment %', missing_deployment_id;
  END IF;
END $$;

-- 旧数据只有订阅的首尾时间；先生成一段最保守的历史区间。新写入路径从本迁移
-- 起逐次追加区间，不覆盖这里已经形成的历史事实。
INSERT INTO strategy_subscription_periods (
  id, subscription_id, customer_id, deployment_id, strategy_code,
  strategy_version_id, symbol, mode, started_at, ended_at
)
SELECT
  'legacy-period:' || deployment.id,
  subscription.id,
  subscription.customer_id,
  deployment.id,
  migration.strategy_code,
  deployment.strategy_version_id,
  migration.symbol,
  deployment.mode,
  COALESCE(
    parse_strategy_work_record_legacy_timestamp(subscription.started_at, 'started_at', subscription.id),
    deployment.created_at
  ),
  CASE
    WHEN parse_strategy_work_record_legacy_timestamp(subscription.ended_at, 'ended_at', subscription.id) IS NOT NULL
      THEN parse_strategy_work_record_legacy_timestamp(subscription.ended_at, 'ended_at', subscription.id)
    WHEN deployment.status IN ('ended', 'failed')
      THEN deployment.updated_at
    ELSE NULL
  END
FROM strategy_deployments AS deployment
JOIN strategy_subscriptions AS subscription
  ON subscription.id = deployment.strategy_subscription_id
JOIN platform_strategy_migration_map AS migration
  ON migration.strategy_id = deployment.strategy_id
 AND migration.strategy_version_id = deployment.strategy_version_id
 AND migration.strategy_code = deployment.platform_strategy_code
WHERE deployment.execution_product = 'spot_usdt'
  AND deployment.mode IN ('shadow', 'paper')
ON CONFLICT (id) DO NOTHING;

DROP FUNCTION parse_strategy_work_record_legacy_timestamp(text, text, text);

-- 后续写入必须证明区间的客户、订阅、部署、版本、策略卡、品种和模式属于同一事实，
-- 并拒绝同一订阅的重叠区间。应用层的 advisory lock 负责并发串行化，本触发器负责
-- defense in depth，避免一次内部写入错误永久扩大公共轮可见范围。
CREATE OR REPLACE FUNCTION validate_strategy_subscription_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('strategy-subscription-period:' || NEW.subscription_id, 0));
  PERFORM 1
  FROM strategy_subscriptions AS subscription
  JOIN strategy_deployments AS deployment
    ON deployment.id = NEW.deployment_id
   AND deployment.strategy_subscription_id = subscription.id
  JOIN platform_strategy_migration_map AS migration
    ON migration.strategy_id = deployment.strategy_id
   AND migration.strategy_version_id = NEW.strategy_version_id
   AND migration.strategy_code = NEW.strategy_code
   AND migration.symbol = NEW.symbol
  WHERE subscription.id = NEW.subscription_id
    AND subscription.customer_id = NEW.customer_id
    AND deployment.owner_user_id = NEW.customer_id
    AND deployment.strategy_version_id = NEW.strategy_version_id
    AND deployment.platform_strategy_code = NEW.strategy_code
    AND deployment.mode = NEW.mode
    AND deployment.execution_product = 'spot_usdt';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'strategy subscription period facts are inconsistent';
  END IF;

  IF EXISTS (
    SELECT 1 FROM strategy_subscription_periods AS existing
    WHERE existing.subscription_id = NEW.subscription_id
      AND existing.id <> NEW.id
      AND existing.started_at < COALESCE(NEW.ended_at, 'infinity'::timestamptz)
      AND NEW.started_at < COALESCE(existing.ended_at, 'infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'strategy subscription periods cannot overlap';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_strategy_subscription_period_consistency ON strategy_subscription_periods;
CREATE TRIGGER trg_strategy_subscription_period_consistency
BEFORE INSERT OR UPDATE ON strategy_subscription_periods
FOR EACH ROW EXECUTE FUNCTION validate_strategy_subscription_period();

-- 区间的身份与起点是不可变事实；唯一允许的修改是把一个开放区间关闭一次。
CREATE OR REPLACE FUNCTION protect_strategy_subscription_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.subscription_id <> OLD.subscription_id
    OR NEW.customer_id <> OLD.customer_id
    OR NEW.deployment_id <> OLD.deployment_id
    OR NEW.strategy_code <> OLD.strategy_code
    OR NEW.strategy_version_id <> OLD.strategy_version_id
    OR NEW.symbol <> OLD.symbol
    OR NEW.mode <> OLD.mode
    OR NEW.started_at <> OLD.started_at
    OR NEW.created_at <> OLD.created_at
    OR OLD.ended_at IS NOT NULL
    OR NEW.ended_at IS NULL
  THEN
    RAISE EXCEPTION 'strategy subscription period is immutable except for first close';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_strategy_subscription_period_immutable ON strategy_subscription_periods;
CREATE TRIGGER trg_strategy_subscription_period_immutable
BEFORE UPDATE ON strategy_subscription_periods
FOR EACH ROW EXECUTE FUNCTION protect_strategy_subscription_period();

-- PRD 的最低保留期是六个月。数据库守门，避免级联删除或维护脚本绕过应用层。
-- 六个月之后仍不自动删除；这里只定义“最早可删时间”，实际清理由受控流程决定。
CREATE OR REPLACE FUNCTION enforce_strategy_work_record_minimum_retention()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  retained_at timestamptz;
BEGIN
  retained_at := NULLIF(to_jsonb(OLD)->>TG_ARGV[0], '')::timestamptz;
  IF retained_at IS NULL OR retained_at > now() - interval '6 months' THEN
    RAISE EXCEPTION 'six-month minimum retention protects this work record';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_strategy_subscription_period_retention ON strategy_subscription_periods;
CREATE TRIGGER trg_strategy_subscription_period_retention
BEFORE DELETE ON strategy_subscription_periods
FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_decision_round_retention ON strategy_decision_rounds;
CREATE TRIGGER trg_strategy_decision_round_retention
BEFORE DELETE ON strategy_decision_rounds
FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_runtime_event_retention ON strategy_runtime_events;
CREATE TRIGGER trg_strategy_runtime_event_retention
BEFORE DELETE ON strategy_runtime_events
FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_runtime_cycle_retention ON strategy_runtime_cycles;
CREATE TRIGGER trg_strategy_runtime_cycle_retention
BEFORE DELETE ON strategy_runtime_cycles
FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention('completed_at');

DROP TRIGGER IF EXISTS trg_market_data_snapshot_retention ON market_data_snapshots;
CREATE TRIGGER trg_market_data_snapshot_retention
BEFORE DELETE ON market_data_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention('created_at');

DROP TRIGGER IF EXISTS trg_official_paper_intent_retention ON official_paper_order_intents;
CREATE TRIGGER trg_official_paper_intent_retention
BEFORE DELETE ON official_paper_order_intents
FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention('created_at');

-- official_paper_fill_receipts 已由 0024 的 append-only 触发器永久保护，无需重复定义。
