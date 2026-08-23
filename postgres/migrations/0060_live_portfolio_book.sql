-- 让实盘组合能有真实本金。
--
-- 这是第六处阻塞，不在 live-readiness 的五条清单里，而它比那五条都根本：
--
--   official_paper_portfolios.principal_usdt  CHECK (principal_usdt = 10000)
--   + 触发器 protect_official_paper_principal 再钉一次
--   + 域层 OfficialPaperPortfolioState.principalUsdt 是字面量类型 10_000
--
-- 而 0053 的约束要求 live 部署必须有 paper_portfolio_id。于是一条实盘部署只能
-- 指向一个本金被写死成 10000 的组合。后果不是报错，是**静默算错**：
--
--   - 风控：回撤与日亏是相对本金的百分比，一个 3000 USDT 的客户按 10000 算，
--     等于风控预算被放大 3.3 倍；
--   - 分成：高水位线绩效分成建立在这个组合的净值上，等于按虚构盈亏计费（INV-5）。
--
-- 0053 的注释说「实盘沿用 paper 的全部结构，走同一条记账路径」——方向对，
-- 但当时没看见本金是钉死的。那句话在本次迁移之前无法成立。
--
-- 做法：不另起一套并行的账。记账数学（均价、成本、已实现盈亏、手续费摊销、
-- 按本金百分比的配置上限）对模拟盘和实盘完全一样，分叉成两套实现，分成口径迟早
-- 也会分叉。改为给同一套表加一个 book 维度：
--
--   book='paper'  本金恒为 10000（模拟盘的产品规则：所有人可横向比较）
--   book='live'   本金为客户投入这张卡的真实资金
--
-- 「10000」从此只是模拟盘的产品规则，不再是记账规则。

ALTER TABLE official_paper_portfolios
  ADD COLUMN IF NOT EXISTS book text NOT NULL DEFAULT 'paper';

ALTER TABLE official_paper_portfolios DROP CONSTRAINT IF EXISTS official_paper_portfolios_book_check;
ALTER TABLE official_paper_portfolios
  ADD CONSTRAINT official_paper_portfolios_book_check CHECK (book IN ('paper', 'live'));

-- 本金规则按 book 分叉。模拟盘那条一字未改。
ALTER TABLE official_paper_portfolios DROP CONSTRAINT IF EXISTS official_paper_portfolios_principal_usdt_check;
ALTER TABLE official_paper_portfolios
  ADD CONSTRAINT official_paper_portfolios_principal_usdt_check
  CHECK (
    (book = 'paper' AND principal_usdt = 10000)
    OR (book = 'live' AND principal_usdt > 0)
  );

-- 触发器同样按 book 分叉。本金在两种账上都不可变——实盘客户追加资金要走一条
-- 显式的入金流程并留痕，而不是把 principal 改大了事：高水位线绩效分成的基准就是
-- 这个数，悄悄改它等于抹掉客户此前的亏损，让平台对没赚回来的部分收分成（INV-5）。
CREATE OR REPLACE FUNCTION protect_official_paper_principal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_usdt <> OLD.principal_usdt THEN
    RAISE EXCEPTION 'official paper principal is immutable';
  END IF;
  IF NEW.book <> OLD.book THEN
    RAISE EXCEPTION 'portfolio book is immutable';
  END IF;
  IF NEW.book = 'paper' AND NEW.principal_usdt <> 10000 THEN
    RAISE EXCEPTION 'official paper principal is immutable';
  END IF;
  RETURN NEW;
END $$;

-- 同一个会员在同一张策略卡上，模拟盘和实盘各一个组合——这是正常形态，
-- 客户先跑模拟再上实盘。原来的 UNIQUE (membership_id, strategy_code) 会挡住它。
ALTER TABLE official_paper_portfolios DROP CONSTRAINT IF EXISTS official_paper_portfolios_membership_id_strategy_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_official_paper_portfolios_membership_card_book
  ON official_paper_portfolios (membership_id, strategy_code, book);

CREATE UNIQUE INDEX IF NOT EXISTS uq_official_paper_portfolios_id_book
  ON official_paper_portfolios (id, book);

-- 部署的 mode 与组合的 book 必须一致，由数据库保证，不靠代码自觉。
--
-- 生成列而不是普通列：普通列要靠写入方填对，而「实盘部署指向了一个模拟盘组合」
-- 恰恰是那种写入方自己不会发现的错误——它不报错，只是把真实成交记进了一本
-- 本金 10000 的假账。生成列由 mode 推出，写入方无从填错。
ALTER TABLE strategy_deployments
  ADD COLUMN IF NOT EXISTS portfolio_book text
  GENERATED ALWAYS AS (CASE WHEN mode = 'live' THEN 'live' ELSE 'paper' END) STORED;

ALTER TABLE strategy_deployments DROP CONSTRAINT IF EXISTS strategy_deployments_portfolio_book_fk;
ALTER TABLE strategy_deployments
  ADD CONSTRAINT strategy_deployments_portfolio_book_fk
  FOREIGN KEY (paper_portfolio_id, portfolio_book)
  REFERENCES official_paper_portfolios (id, book);

-- 实盘组合必须记住它对着哪个交易所账户。
--
-- 没有它，一个客户在同一张卡上先后绑过两个交易所账户时，两段成交会记进同一本账，
-- 而那本账对应的真实资金早已换了地方——净值、回撤、分成全部错位。
ALTER TABLE official_paper_portfolios
  ADD COLUMN IF NOT EXISTS exchange_account_id text;

ALTER TABLE official_paper_portfolios DROP CONSTRAINT IF EXISTS official_paper_portfolios_live_has_account;
ALTER TABLE official_paper_portfolios
  ADD CONSTRAINT official_paper_portfolios_live_has_account
  CHECK ((book = 'live') = (exchange_account_id IS NOT NULL));

-- 刻意不改的一条：idx_strategy_deployments_one_active_official_card 仍然是
-- (owner_user_id, platform_strategy_code) WHERE spot_usdt AND active，与 mode 无关。
--
-- 于是同一张卡上，模拟盘和实盘不能同时在跑——上实盘要先停掉那张卡的模拟部署。
-- 这是刻意保留的：两个部署会在同一批 K 线上各自产出决策，客户会看到同一张卡给出
-- 两套互相矛盾的叙述，而「可解释」是这个产品的全部卖点。
--
-- 模拟盘那本账不会消失（组合与成交记录都留着），停的只是继续下单的部署。
