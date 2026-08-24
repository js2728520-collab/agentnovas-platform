-- 客户的行情源偏好（T2.4b-2）。
--
-- 这张表与 0078 的 `strategy_market_source_bindings` 是**两件事**，混淆它们会直接毁掉
-- 0078 存在的理由：
--
--   偏好（本表）  可变。客户当前想用哪个源。改了立刻生效于**之后**的解析。
--   绑定（0078）  不可变。某个部署当初实际解析到了哪个源。改了等于篡改决策证据链。
--
-- 客户改偏好不会动既有部署的绑定，这正是「同一段历史决策不会在事后被换个数据源解释」
-- 的来源。

CREATE TABLE IF NOT EXISTS customer_market_source_preferences (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 偏好按市场存，不按策略存。官方卡的源由平台指定（ADR-0025），因此这张表在结构上
  -- 就无法表达「给某张官方卡换源」——没有 strategy_code 列可写。
  market_id text NOT NULL,
  selection_mode text NOT NULL CHECK (selection_mode IN ('account_aligned', 'independent')),
  -- account_aligned 用客户自己的交易所账户取行情；independent 用平台登记的公共/授权源。
  account_id text REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, market_id),
  -- 两种模式各自恰好带一个标识。允许两个都填会让「客户选的到底是哪个」出现两个答案，
  -- 而解析时只会读其中一个——另一个成为看不见的错误配置。
  CONSTRAINT customer_market_source_preferences_mode_target_check CHECK (
    (selection_mode = 'account_aligned' AND account_id IS NOT NULL AND provider_id IS NULL)
    OR (selection_mode = 'independent' AND provider_id IS NOT NULL AND account_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_customer_market_source_preferences_owner
  ON customer_market_source_preferences (owner_user_id);

COMMENT ON TABLE customer_market_source_preferences IS
  'Mutable per-customer market data source preference. Applies to display and research only; official strategy cards always use the platform-designated source (ADR-0025). Immutable per-deployment resolutions live in strategy_market_source_bindings.';

-- 偏好属于客户自己的数据，Client 端读写；内部端只读，用于客服排查「我看到的报价为什么
-- 和别人不一样」。Runtime Worker 需要读：自定义策略部署解析源时要用客户当时的偏好。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT, INSERT, UPDATE ON customer_market_source_preferences TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT SELECT ON customer_market_source_preferences TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON customer_market_source_preferences TO agentnovas_maint_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_runtime_worker') THEN
    GRANT SELECT ON customer_market_source_preferences TO agentnovas_runtime_worker;
  END IF;
END $$;
