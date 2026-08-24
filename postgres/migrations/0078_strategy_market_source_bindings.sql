-- 行情源绑定的持久化（T2.4b-1）。
--
-- T2.4a 已经定义了解析合同与双 fingerprint；这里把解析结果**固定**到具体的策略部署上。
-- 「固定」是这张表存在的全部理由：客户改了当前偏好，既有部署仍按当初解析出来的源运行，
-- 否则同一段历史决策会在事后被换成另一个数据源解释，回放与归因都不再成立。

CREATE TABLE IF NOT EXISTS strategy_market_source_bindings (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES strategy_deployments(id) ON DELETE RESTRICT,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- 绑定固定到策略版本：换版本要重新解析，不能沿用旧绑定（同 DSL 换源必须重测）。
  strategy_version_id text NOT NULL,
  market_id text NOT NULL,
  instrument_id text NOT NULL,
  selection_mode text NOT NULL CHECK (selection_mode IN ('account_aligned', 'independent')),
  provider_id text NOT NULL,
  provider_symbol text NOT NULL,
  account_id text,
  source_account_id text,
  requested_usage text NOT NULL CHECK (requested_usage IN ('display', 'research')),
  authorization_kind text NOT NULL CHECK (authorization_kind IN ('public', 'licensed', 'customer_account')),
  capability_version_id text NOT NULL,
  fingerprint_version integer NOT NULL DEFAULT 1 CHECK (fingerprint_version = 1),
  source_policy_fingerprint text NOT NULL CHECK (source_policy_fingerprint ~ '^[a-f0-9]{64}$'),
  binding_instance_fingerprint text NOT NULL CHECK (binding_instance_fingerprint ~ '^[a-f0-9]{64}$'),
  -- 历史部署在本迁移之前就已存在，它们从未经过源解析。标成 legacy_unpinned 而不是
  -- 编一个绑定：假绑定会让「这一轮用的是哪个源」这个问题得到一个看似确定的错误答案。
  pinning text NOT NULL DEFAULT 'pinned' CHECK (pinning IN ('pinned', 'legacy_unpinned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 每个 (部署, 策略版本) 只有一条绑定。重复解析必须落在同一行上。
  UNIQUE (deployment_id, strategy_version_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_market_source_bindings_owner
  ON strategy_market_source_bindings (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_market_source_bindings_policy
  ON strategy_market_source_bindings (source_policy_fingerprint);

-- 绑定不可改写。
--
-- 「不可变」在这里不是洁癖：绑定是决策轮证据链的一环，能改写它就能事后重写「这一轮
-- 依据的是哪个数据源」。允许的唯一变化是 legacy_unpinned → pinned（历史记录补上真实
-- 解析结果），且补的时候必须同时写入两个 fingerprint。
CREATE OR REPLACE FUNCTION protect_strategy_market_source_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MARKET_SOURCE_BINDING_IMMUTABLE';
  END IF;

  IF OLD.pinning = 'legacy_unpinned' AND NEW.pinning = 'pinned' THEN
    IF NEW.deployment_id <> OLD.deployment_id
      OR NEW.owner_user_id <> OLD.owner_user_id
      OR NEW.strategy_version_id <> OLD.strategy_version_id THEN
      RAISE EXCEPTION 'MARKET_SOURCE_BINDING_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'MARKET_SOURCE_BINDING_IMMUTABLE';
END $$;

DROP TRIGGER IF EXISTS trg_strategy_market_source_binding_immutable ON strategy_market_source_bindings;
CREATE TRIGGER trg_strategy_market_source_binding_immutable
  BEFORE UPDATE OR DELETE ON strategy_market_source_bindings
  FOR EACH ROW EXECUTE FUNCTION protect_strategy_market_source_binding();

-- 回填：现有官方 spot 部署标记为 legacy_unpinned。
--
-- 这些部署当初没有源选择这个概念，全部走同一个公共源。回填只是如实登记「未固定」，
-- 不假装它们做过解析；fingerprint 用全零占位，配合 pinning 一起表达「这不是真解析结果」。
INSERT INTO strategy_market_source_bindings (
  id, deployment_id, owner_user_id, strategy_version_id, market_id, instrument_id,
  selection_mode, provider_id, provider_symbol, account_id, source_account_id,
  requested_usage, authorization_kind, capability_version_id,
  source_policy_fingerprint, binding_instance_fingerprint, pinning
)
SELECT
  'legacy-binding-' || md5(deployment.id || ':' || deployment.strategy_version_id),
  deployment.id,
  deployment.owner_user_id,
  deployment.strategy_version_id,
  'crypto-global',
  COALESCE(mapping.symbol, 'UNKNOWN'),
  'independent',
  'public-binance-market-data',
  COALESCE(mapping.symbol, 'UNKNOWN'),
  NULL,
  NULL,
  'research',
  'public',
  'legacy-unpinned',
  repeat('0', 64),
  repeat('0', 64),
  'legacy_unpinned'
FROM strategy_deployments AS deployment
LEFT JOIN platform_strategy_migration_map AS mapping
  ON mapping.strategy_id = deployment.strategy_id
 AND mapping.strategy_version_id = deployment.strategy_version_id
WHERE deployment.execution_product = 'spot_usdt'
ON CONFLICT (deployment_id, strategy_version_id) DO NOTHING;
