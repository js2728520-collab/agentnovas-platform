-- 跟单风控停止与下架原因（T4.4b）。
--
-- 需求方确认两条：自动风控用**合同里客户自己设的止损线**；下架时**区分原因**——作者主动
-- 下架不影响存量跟随，平台因风险或合规下架则自动阻断全部存量跟随。

-- 下架原因。此前 status='delisted' 说不出是作者要换版本还是平台发现了问题，而这两件事
-- 对已经跟随的客户意味着完全相反的处理。
ALTER TABLE community_strategies
  ADD COLUMN IF NOT EXISTS delist_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_strategies_delist_reason_check' AND conrelid = 'community_strategies'::regclass) THEN
    ALTER TABLE community_strategies
      ADD CONSTRAINT community_strategies_delist_reason_check CHECK (
        (status <> 'delisted' AND delist_reason IS NULL)
        OR (status = 'delisted' AND delist_reason IN (
          'author_request',        -- 作者主动下架：走 7 天通知缓冲期，不阻断存量
          'inactivity',            -- 滚动 30 天有效跟随不足，自动下架：同样不阻断存量
          'platform_risk',         -- 平台发现风险：阻断全部存量跟随
          'platform_compliance'    -- 合规原因：阻断全部存量跟随
        ))
      );
  END IF;
END $$;

COMMENT ON COLUMN community_strategies.delist_reason IS
  'Why the strategy was delisted. platform_risk / platform_compliance auto-block existing followers; author_request / inactivity do not (they go through the 7-day notice period instead).';

-- 风控停止事件。
--
-- 「谁停的」已经在 strategy_subscriptions.paused_by 上，但那只保留**当前**状态。事件表
-- 保留完整历史：一个反复被停又恢复的跟随，事后要能看出发生过几次、每次为什么。
CREATE TABLE IF NOT EXISTS strategy_follow_risk_events (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES strategy_subscriptions(id) ON DELETE RESTRICT,
  authority text NOT NULL CHECK (authority IN (
    'customer','operations_risk','automated_risk','global_circuit_breaker'
  )),
  action text NOT NULL CHECK (action IN ('pause','resume','stop')),
  -- 触发的规则（自动风控）或人工填写的原因（运营/客户）。没有理由的停止，事后没人知道
  -- 能不能摘。
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  triggered_rules_json jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(triggered_rules_json) = 'array'),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence_json) = 'object'),
  actor_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  -- 自动风控与全局熔断没有 actor；人工动作必须有。
  CONSTRAINT strategy_follow_risk_events_actor_check CHECK (
    (authority IN ('customer','operations_risk')) = (actor_user_id IS NOT NULL)
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strategy_follow_risk_events_subscription
  ON strategy_follow_risk_events (subscription_id, created_at DESC);

-- 事件 append-only。能改写风控事件就能事后否认一次阻断发生过。
CREATE OR REPLACE FUNCTION protect_strategy_follow_risk_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FOLLOW_RISK_EVENT_APPEND_ONLY';
END $$;

DROP TRIGGER IF EXISTS trg_strategy_follow_risk_event_append_only ON strategy_follow_risk_events;
CREATE TRIGGER trg_strategy_follow_risk_event_append_only
  BEFORE UPDATE OR DELETE ON strategy_follow_risk_events
  FOR EACH ROW EXECUTE FUNCTION protect_strategy_follow_risk_event();

-- 运营端风控停止权限。
--
-- 与 ops.trading.manage 分开：那条管的是交易所/账户/策略卡维度的熔断，这条管的是单个
-- 客户对单个社区策略的跟随。合并会让能挂全局熔断的人顺带获得逐客户操作权，反之亦然。
INSERT INTO "permission_definitions" ("key", "application_id", "label", "sensitive", "status")
VALUES
  ('ops.follow_risk.view', 'operations', '查看跟单风控状态', false, 'active'),
  ('ops.follow_risk.manage', 'operations', '阻断或恢复客户跟单', true, 'active')
ON CONFLICT ("key") DO UPDATE
  SET "application_id" = EXCLUDED."application_id",
      "label" = EXCLUDED."label",
      "sensitive" = EXCLUDED."sensitive",
      "status" = EXCLUDED."status";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT SELECT, INSERT ON strategy_follow_risk_events TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT, INSERT ON strategy_follow_risk_events TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_runtime_worker') THEN
    GRANT SELECT, INSERT ON strategy_follow_risk_events TO agentnovas_runtime_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON strategy_follow_risk_events TO agentnovas_maint_web;
  END IF;
END $$;
