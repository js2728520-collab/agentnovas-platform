-- 执行对账。
--
-- 背景：下单响应不能当作事实。市价单可能在响应之后才成交，超时的请求可能已经
-- 到了交易所。「以为没成交」和「以为成交了」会往相反的方向出错，而前者更危险：
-- 它会让重试变成重复下单。
--
-- 因此每一笔真实下单都要在这里留一条待对账记录，由对账任务反复查单直到确认，
-- 或者升级人工。见 docs/adr/0019 第 4 步。
--
-- 状态机的判定在 packages/domain/src/execution/reconciliation.ts（纯函数、可单测），
-- 本表只负责持久化与租约。

CREATE TABLE IF NOT EXISTS execution_reconciliations (
  id text PRIMARY KEY,

  -- 我们自己派生的幂等标识。**唯一约束是这张表的核心**：
  -- 同一笔下单无论被登记多少次，都只能有一条对账记录，否则对账任务会对同一个
  -- 订单并发查单并各自结案，写出互相矛盾的回执。
  client_order_id text NOT NULL UNIQUE,

  account_id text NOT NULL,
  customer_id text NOT NULL,
  exchange text NOT NULL,
  symbol text NOT NULL,
  -- 下单时请求的数量。判断部分成交要用它，不能事后从别处推。
  requested_quantity double precision NOT NULL CHECK (requested_quantity > 0),

  -- 溯源：这笔单出自哪一轮决策、哪一个组合。可解释、可审计的底线（INV-8）。
  decision_round_id text,
  portfolio_id text,
  intent_id text,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'escalated')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  -- 结案后的事实。resolved 之前全部为空。
  resolved_outcome text CHECK (resolved_outcome IN ('filled', 'partial', 'rejected', 'expired')),
  filled_quantity double precision CHECK (filled_quantity >= 0),
  average_price double precision CHECK (average_price >= 0),
  rejection_reason text,
  external_order_id text,
  resolved_at timestamptz,

  escalation_reason text,
  escalated_at timestamptz,
  -- 运维处理完之后填。未处理的升级会一直挡住该账户开新仓。
  acknowledged_at timestamptz,
  acknowledged_by text,

  -- 对账任务的租约，防止多个 Worker 同时处理同一条。
  leased_by text,
  leased_until timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- 结案必须留下事实，升级必须留下原因。允许状态为终态却什么都没写，
  -- 等于允许「对完账了但说不出对到了什么」。
  CONSTRAINT execution_reconciliations_resolved_has_outcome
    CHECK (status <> 'resolved' OR (resolved_outcome IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT execution_reconciliations_escalated_has_reason
    CHECK (status <> 'escalated' OR (escalation_reason IS NOT NULL AND escalated_at IS NOT NULL))
);

-- 对账任务取件：只扫 pending，按到期时间取。
CREATE INDEX IF NOT EXISTS idx_execution_reconciliations_due
  ON execution_reconciliations (next_attempt_at)
  WHERE status = 'pending';

-- 开仓准入要问「这个账户有没有未决对账」，这是热路径。
CREATE INDEX IF NOT EXISTS idx_execution_reconciliations_account_open
  ON execution_reconciliations (account_id, symbol)
  WHERE status IN ('pending', 'escalated');

-- 运维端待办：未确认的升级。
CREATE INDEX IF NOT EXISTS idx_execution_reconciliations_unacknowledged
  ON execution_reconciliations (escalated_at DESC)
  WHERE status = 'escalated' AND acknowledged_at IS NULL;

CREATE OR REPLACE FUNCTION touch_execution_reconciliations_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_reconciliations_touch ON execution_reconciliations;
CREATE TRIGGER execution_reconciliations_touch
  BEFORE UPDATE ON execution_reconciliations
  FOR EACH ROW EXECUTE FUNCTION touch_execution_reconciliations_updated_at();

-- 结案后不得再改成别的结论。
--
-- 对账记录是回执的依据，回执是绩效分成的依据。一条能被改写的对账记录意味着
-- 已结算的分成可以被事后改动——那正是「可审计」要挡住的事。
CREATE OR REPLACE FUNCTION enforce_execution_reconciliation_terminal()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'resolved' AND NEW.status <> 'resolved' THEN
    RAISE EXCEPTION '已结案的对账记录不得回到 % 状态（client_order_id=%）', NEW.status, OLD.client_order_id;
  END IF;
  IF OLD.status = 'resolved' AND (
    NEW.resolved_outcome IS DISTINCT FROM OLD.resolved_outcome
    OR NEW.filled_quantity IS DISTINCT FROM OLD.filled_quantity
    OR NEW.average_price IS DISTINCT FROM OLD.average_price
  ) THEN
    RAISE EXCEPTION '已结案的成交事实不可改写（client_order_id=%）', OLD.client_order_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_reconciliations_terminal ON execution_reconciliations;
CREATE TRIGGER execution_reconciliations_terminal
  BEFORE UPDATE ON execution_reconciliations
  FOR EACH ROW EXECUTE FUNCTION enforce_execution_reconciliation_terminal();
