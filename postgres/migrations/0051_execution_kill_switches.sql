-- 执行熔断开关。
--
-- 运营按三个并列维度暂停新开仓：交易所、客户账户、策略卡。命中任意一个即挡住，
-- 因为它们对应三种不同的事故。
--
-- 本表的形状体现一条刻意的不对称（见 packages/domain/src/execution/kill-switch.ts）：
--
--   挂上开关是单人即时生效的——出事时没有时间等第二个人批准；
--   摘掉开关要走 maker/checker——恢复交易才是把风险放回去的方向。
--
-- 把这条写反的系统看起来更严格，实际更危险：在最需要停下来的那一刻停不下来。
--
-- 见 docs/adr/0019 第 5 步。

CREATE TABLE IF NOT EXISTS execution_kill_switches (
  id text PRIMARY KEY,

  dimension text NOT NULL CHECK (dimension IN ('exchange', 'account', 'strategy')),
  -- 该维度下被暂停的具体对象：交易所代号 / 账户 id / 策略卡代号。
  scope_value text NOT NULL,

  active boolean NOT NULL DEFAULT true,

  -- 挂上开关：单人即时。原因必填——一个没有理由的熔断，事后没人知道能不能摘。
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  engaged_by text NOT NULL,
  engaged_at timestamptz NOT NULL DEFAULT now(),

  -- 摘除走 maker/checker：先发起申请，批准后才真的失效。
  release_request_id text,
  release_requested_by text,
  release_requested_at timestamptz,
  released_by text,
  released_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 摘除必须留下是谁批的与何时。允许 active=false 却没有解除记录，
  -- 等于允许熔断被静默摘掉。
  CONSTRAINT execution_kill_switches_release_is_recorded
    CHECK (active OR (released_by IS NOT NULL AND released_at IS NOT NULL))
);

-- 同一个对象同时只能有一个生效中的开关。
--
-- 没有它，同一个交易所可以被挂上 N 次，摘掉其中一个之后别的还在生效，
-- 而运营界面上看起来已经解除了——最危险的那种不一致：以为恢复了，其实没有。
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_kill_switches_active_scope
  ON execution_kill_switches (dimension, scope_value)
  WHERE active;

-- 下单准入要读全部生效开关，这是热路径。
CREATE INDEX IF NOT EXISTS idx_execution_kill_switches_active
  ON execution_kill_switches (dimension, scope_value)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_execution_kill_switches_history
  ON execution_kill_switches (engaged_at DESC);

CREATE OR REPLACE FUNCTION touch_execution_kill_switches_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_kill_switches_touch ON execution_kill_switches;
CREATE TRIGGER execution_kill_switches_touch
  BEFORE UPDATE ON execution_kill_switches
  FOR EACH ROW EXECUTE FUNCTION touch_execution_kill_switches_updated_at();

-- 已解除的开关不得被复活成生效，历史也不得被改写。
--
-- 复活会绕过「挂上要写原因和责任人」这条：把一条旧记录翻出来置 active，
-- 就得到了一个没有当次原因、没有当次责任人的熔断。要停就重新挂一条。
CREATE OR REPLACE FUNCTION enforce_execution_kill_switch_history()
RETURNS trigger AS $$
BEGIN
  IF NOT OLD.active AND NEW.active THEN
    RAISE EXCEPTION '已解除的熔断不得复活（dimension=%, scope=%）；要停请新挂一条', OLD.dimension, OLD.scope_value;
  END IF;
  IF NEW.dimension IS DISTINCT FROM OLD.dimension
     OR NEW.scope_value IS DISTINCT FROM OLD.scope_value
     OR NEW.engaged_by IS DISTINCT FROM OLD.engaged_by
     OR NEW.engaged_at IS DISTINCT FROM OLD.engaged_at
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION '熔断的挂起记录不可改写（id=%）', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_kill_switches_history ON execution_kill_switches;
CREATE TRIGGER execution_kill_switches_history
  BEFORE UPDATE ON execution_kill_switches
  FOR EACH ROW EXECUTE FUNCTION enforce_execution_kill_switch_history();
