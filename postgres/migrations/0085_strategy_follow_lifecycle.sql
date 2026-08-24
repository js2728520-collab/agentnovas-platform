-- 跟单生命周期与四方停止（T4.4 / PRD 6.6）。
--
-- 此前 strategy_subscriptions.status 只有 pending/active/paused/ended，**没有任何地方记录
-- 是谁停的**。后果是客户可以自己恢复一个被风控停掉的跟随：风控判定形同虚设，而界面上
-- 完全看不出异常。

-- 状态改名并补齐 PRD 6.6 的六态。
UPDATE strategy_subscriptions SET status = 'configuring' WHERE status = 'pending';
UPDATE strategy_subscriptions SET status = 'stopped' WHERE status IN ('ended', 'cancelled');
UPDATE strategy_subscriptions
   SET status = 'configuring'
 WHERE status NOT IN ('configuring','user_confirmed','active','paused','risk_blocked','stopped');

ALTER TABLE strategy_subscriptions DROP CONSTRAINT IF EXISTS strategy_subscriptions_status_check;
ALTER TABLE strategy_subscriptions
  ADD CONSTRAINT strategy_subscriptions_status_check CHECK (status IN (
    'configuring','user_confirmed','active','paused','risk_blocked','stopped'
  ));

-- 谁停的。没有这一列，「暂停」与「风控阻断」就只是两个措辞不同的同一件事。
ALTER TABLE strategy_subscriptions
  ADD COLUMN IF NOT EXISTS paused_by text,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_reason text,
  ADD COLUMN IF NOT EXISTS ended_by text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_subscriptions_stop_authority_check') THEN
    ALTER TABLE strategy_subscriptions
      ADD CONSTRAINT strategy_subscriptions_stop_authority_check CHECK (
        (paused_by IS NULL OR paused_by IN ('customer','operations_risk','automated_risk','global_circuit_breaker'))
        AND (ended_by IS NULL OR ended_by IN ('customer','operations_risk','automated_risk','global_circuit_breaker'))
        -- 暂停态必须说得出是谁停的；非暂停态不得残留 paused_by。残留会让下一次恢复
        -- 按一个早已失效的权威判定。
        AND (status IN ('paused','risk_blocked')) = (paused_by IS NOT NULL)
        AND (paused_by IS NULL) = (paused_at IS NULL)
        -- 风控阻断只能由风控性质的三方造成；客户暂停不得被记成风控阻断。
        AND (status <> 'risk_blocked' OR paused_by IN ('operations_risk','automated_risk','global_circuit_breaker'))
        AND (status <> 'paused' OR paused_by = 'customer')
      );
  END IF;
END $$;

-- 0082 的结束守卫按旧词表写的，跟着改。
CREATE OR REPLACE FUNCTION protect_subscription_on_delisting()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status = 'stopped'
    AND OLD.status IN ('active','paused','risk_blocked','user_confirmed','configuring') THEN
    IF NEW.ended_reason IS NULL THEN
      RAISE EXCEPTION 'SUBSCRIPTION_END_REASON_REQUIRED';
    END IF;
    -- 终止同样要说得出是哪一方做的（PRD 6.6 的四方）。
    IF NEW.ended_by IS NULL THEN
      RAISE EXCEPTION 'SUBSCRIPTION_END_AUTHORITY_REQUIRED';
    END IF;
    IF NEW.ended_reason = 'change_request' AND NOT EXISTS (
      SELECT 1 FROM strategy_change_requests
       WHERE strategy_id = NEW.strategy_id AND status = 'completed'
    ) THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHANGE_REQUEST_NOT_COMPLETED';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON COLUMN strategy_subscriptions.paused_by IS
  'Which of the four PRD 6.6 authorities paused this follow. Determines who may resume it: a resuming party must rank at least as high as the pausing party.';
