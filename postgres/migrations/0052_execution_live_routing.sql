-- 实盘路由授权。
--
-- 前五步都在加保护，这一步是把保护往回放一点，因此这张表的形状必须让「放开」
-- 比「收回」更难：
--
--   开通实盘走 maker/checker——开通是把风险放回去；
--   关停立即生效、单人即可——关停是把风险收回来。
--
-- 这与熔断开关的不对称是同一条原则的两面（0051）：**让系统更安全的动作永远比让
-- 系统更危险的动作容易做。**
--
-- 永续合约不在本表的表达能力之内：CHECK 只允许 spot_usdt。即使有人试图插入一条
-- 永续授权，数据库也会拒绝，域层还会再拒绝一次。
--
-- 见 docs/adr/0019 第 6 步。

CREATE TABLE IF NOT EXISTS execution_live_routing (
  id text PRIMARY KEY,

  exchange text NOT NULL CHECK (exchange = lower(btrim(exchange)) AND length(exchange) > 0),
  environment text NOT NULL CHECK (environment IN ('demo', 'live')),
  -- 只有现货。这不是默认值，是这张表能表达的全部。
  product text NOT NULL DEFAULT 'spot_usdt' CHECK (product = 'spot_usdt'),

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'granted', 'revoked')),

  -- 申请开通（maker）
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  request_note text NOT NULL DEFAULT '',
  approval_request_id text,

  -- 批准开通（checker）。必须与申请人不同，由仓储层的 SQL 与路由层各挡一次。
  granted_by text,
  granted_at timestamptz,

  -- 关停：单人即时。
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT execution_live_routing_granted_is_recorded
    CHECK (status <> 'granted' OR (granted_by IS NOT NULL AND granted_at IS NOT NULL)),
  CONSTRAINT execution_live_routing_revoked_is_recorded
    CHECK (status <> 'revoked' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  -- 自己批准自己等于没有 maker/checker。数据库是这条规则的最后一道。
  CONSTRAINT execution_live_routing_no_self_approval
    CHECK (granted_by IS NULL OR granted_by <> requested_by)
);

-- 同一个 (交易所, 环境) 同时只能有一条未关停的记录。
--
-- 没有它，同一个交易所可以有两条 granted，关掉一条之后另一条还在生效，
-- 而界面显示已关停——「以为关了，其实没关」在这一步的代价是真实资金。
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_live_routing_open
  ON execution_live_routing (exchange, environment)
  WHERE status IN ('pending', 'granted');

CREATE INDEX IF NOT EXISTS idx_execution_live_routing_granted
  ON execution_live_routing (exchange, environment)
  WHERE status = 'granted';

CREATE INDEX IF NOT EXISTS idx_execution_live_routing_history
  ON execution_live_routing (requested_at DESC);

CREATE OR REPLACE FUNCTION touch_execution_live_routing_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_live_routing_touch ON execution_live_routing;
CREATE TRIGGER execution_live_routing_touch
  BEFORE UPDATE ON execution_live_routing
  FOR EACH ROW EXECUTE FUNCTION touch_execution_live_routing_updated_at();

-- 已关停的授权不得复活，申请与批准的记录不得改写。
--
-- 复活会绕过 maker/checker：把一条旧的 granted 记录翻出来置回 granted，就得到了
-- 一个没有当次申请、没有当次批准的实盘授权。要重开就重新申请。
CREATE OR REPLACE FUNCTION enforce_execution_live_routing_history()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION '已关停的实盘授权不得复活（%/%）；要重开请重新申请', OLD.exchange, OLD.environment;
  END IF;
  IF NEW.exchange IS DISTINCT FROM OLD.exchange
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.product IS DISTINCT FROM OLD.product
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION '实盘授权的申请记录不可改写（id=%）', OLD.id;
  END IF;
  IF OLD.status = 'granted' AND NEW.status = 'granted'
     AND (NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.granted_at IS DISTINCT FROM OLD.granted_at) THEN
    RAISE EXCEPTION '实盘授权的批准记录不可改写（id=%）', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_live_routing_history ON execution_live_routing;
CREATE TRIGGER execution_live_routing_history
  BEFORE UPDATE ON execution_live_routing
  FOR EACH ROW EXECUTE FUNCTION enforce_execution_live_routing_history();
