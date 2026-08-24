-- 客户投稿策略在 paper 下走现货（需求方 2026-08-24 确认）。
--
-- 此前 0053 的约束规定「现货部署必须是官方卡」，客户自定义策略只能走 usdt_perpetual，
-- 而永续路由硬关闭——于是社区策略的跟单一笔成交都产生不了，T4.3b 的结算链没有盈亏来源。
--
-- 改走现货同时也更安全：CLAUDE.md 的「只有现货可路由」是一条不许做成配置项的规则，
-- 把社区策略从永续挪到现货是朝着它走，不是绕开它。

-- 跟单的模拟组合。
--
-- 不复用 official_paper_portfolios：那张表的 strategy_code 被 CHECK 限定为三张官方卡，
-- principal_usdt 被 CHECK 锁死为 10000。两条都是官方卡的产品定义，为了塞进社区策略而
-- 放宽它们，等于让「这是不是官方卡」不再能从数据判断。
CREATE TABLE IF NOT EXISTS strategy_follow_paper_portfolios (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES strategy_subscriptions(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  strategy_id text NOT NULL REFERENCES community_strategies(id) ON DELETE RESTRICT,
  -- 默认与官方卡同为 10,000 USDT，保持客户对「模拟盘本金」的一致预期。**不 CHECK 锁死**：
  -- 是否允许客户自选名义本金是一个尚未做出的产品决策，锁死会让将来改动需要迁移数据。
  principal_usdt numeric(30, 12) NOT NULL DEFAULT 10000 CHECK (principal_usdt > 0),
  cash_usdt numeric(30, 12) NOT NULL DEFAULT 10000 CHECK (cash_usdt >= 0),
  realized_gross_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  realized_net_pnl_usdt numeric(30, 12) NOT NULL DEFAULT 0,
  fees_usdt numeric(30, 12) NOT NULL DEFAULT 0 CHECK (fees_usdt >= 0),
  access_status text NOT NULL DEFAULT 'active'
    CHECK (access_status IN ('active', 'close_only', 'read_only')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一次订阅一个组合。
  UNIQUE (subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_follow_paper_portfolios_customer
  ON strategy_follow_paper_portfolios (customer_id, strategy_id);

ALTER TABLE strategy_deployments
  ADD COLUMN IF NOT EXISTS follow_paper_portfolio_id text
    REFERENCES strategy_follow_paper_portfolios(id) ON DELETE RESTRICT;

-- 放宽 0053 的绑定约束：增加第三个分支——社区策略的现货模拟部署。
--
-- 三条边界写死在分支里，不靠代码自觉：
--   1. 社区策略部署**没有** platform_strategy_code（否则就分不清它是不是官方卡）
--   2. mode 只能是 shadow 或 paper——**实盘对社区策略仍然关闭**
--   3. 不绑交易所账户——paper 不碰真实账户
ALTER TABLE strategy_deployments DROP CONSTRAINT IF EXISTS strategy_deployments_official_binding_check;
ALTER TABLE strategy_deployments
  ADD CONSTRAINT strategy_deployments_official_binding_check
  CHECK (
    -- 官方卡现货（0053 原样保留）
    (
      execution_product = 'spot_usdt'
      AND paper_portfolio_id IS NOT NULL
      AND membership_id IS NOT NULL
      AND platform_strategy_code IS NOT NULL
      AND follow_paper_portfolio_id IS NULL
      AND (mode = 'live') = (exchange_account_id IS NOT NULL)
    )
    -- 社区策略现货模拟（本迁移新增）
    OR (
      execution_product = 'spot_usdt'
      AND platform_strategy_code IS NULL
      AND membership_id IS NULL
      AND paper_portfolio_id IS NULL
      AND strategy_subscription_id IS NOT NULL
      AND follow_paper_portfolio_id IS NOT NULL
      AND mode IN ('shadow', 'paper')
      AND exchange_account_id IS NULL
    )
    -- 遗留永续（路由仍然硬关闭）
    OR (
      execution_product = 'usdt_perpetual'
      AND exchange_account_id IS NOT NULL
      AND paper_portfolio_id IS NULL
      AND membership_id IS NULL
      AND platform_strategy_code IS NULL
      AND follow_paper_portfolio_id IS NULL
    )
  );

-- 一次订阅只有一个生效中的部署。
--
-- 没有它，同一个跟随可以被两个部署驱动，模拟组合上会记两倍仓位。
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_deployments_active_follow
  ON strategy_deployments (strategy_subscription_id)
  WHERE platform_strategy_code IS NULL AND status = 'active' AND strategy_subscription_id IS NOT NULL;

COMMENT ON COLUMN strategy_deployments.follow_paper_portfolio_id IS
  'Paper portfolio for a community-strategy follow. Mutually exclusive with paper_portfolio_id (official cards) — the binding CHECK enforces that a deployment is one kind or the other, never both.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT, INSERT, UPDATE ON strategy_follow_paper_portfolios TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_runtime_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON strategy_follow_paper_portfolios TO agentnovas_runtime_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT SELECT ON strategy_follow_paper_portfolios TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON strategy_follow_paper_portfolios TO agentnovas_maint_web;
  END IF;
END $$;
