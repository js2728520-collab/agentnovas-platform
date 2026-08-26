-- 会员计划改为 USDT 计价。
--
-- 此前存在一处跨越三个环节的币种不一致：
--
--   充值进来      USDT   （deposit_orders.currency 默认 'USDT'）
--   会员计划定价  USD    （commercial_plan_versions.price_currency）
--   绩效分成      USDT   （performance-fee-service 里写死）
--
-- 而 wallet_balances 有 UNIQUE (user_id, currency)——**余额按币种分行，不通用**。
-- 于是客户充进来的 USDT 付不了 USD 计价的会员：那个 USD 钱包余额恒为 0，
-- 钱包支付必然返回「余额不足」。
--
-- 选择改定价而不是加汇率换算：平台实际收付的就是 USDT，USD 只是个显示单位。
-- 引入汇率会带来汇率来源、汇率时点、滑点争议——那是给一个自己造出来的问题引入
-- 一整套新机制。
--
-- 金额不变，只改币种标签。当前没有真实订单，这是代价最低的时点。

-- 原有的 CHECK 把币种锁成 USD，必须先放开才能改数据。
ALTER TABLE commercial_plan_versions DROP CONSTRAINT IF EXISTS commercial_plan_versions_price_currency_check;

UPDATE commercial_plan_versions
   SET price_currency = 'USDT'
 WHERE price_currency = 'USD';

-- 订单表上有一条独立的币种 CHECK，同样锁死 USD。它必须一起改，否则新订单从计划表
-- 取到 USDT 后会撞上订单表的约束——一个「计划改好了但下不了单」的半截状态。
--
-- 顺带印证了这次不一致的范围：performance_fee_statements 与
-- performance_fee_receivables 上的同类约束本来就是 USDT。
ALTER TABLE commercial_membership_orders DROP CONSTRAINT IF EXISTS commercial_membership_orders_price_currency_check;

UPDATE commercial_membership_orders
   SET price_currency = 'USDT'
 WHERE price_currency = 'USD' AND status IN ('pending_evidence', 'pending_review');

-- **订单表不加新的 CHECK。**
--
-- 第一版这里加了 `CHECK (price_currency = 'USDT')`，但那与上一句直接矛盾：
-- 已激活/已拒绝的历史订单要保留原币种（它们记录的是当时的事实），而一条禁止 USD
-- 的约束会让那些行无法存在。两者不可能同时成立。
--
-- 约束只加在 commercial_plan_versions 上——那是**新定价的来源**，管住它就管住了
-- 今后所有新订单的币种；历史订单是既成事实，不该被追溯校验。
--
-- 上面的 WHERE 只改还未结算的订单：它们的金额尚未进过账本，改币种不影响任何已
-- 发生的记账。

-- 防止今后再插入 USD 计价的计划版本，让不一致无法悄悄回来。
-- 列默认值也要改，否则 0023 不再可重放。
--
-- 0023 的计划种子省略了 price_currency，走的是列默认值 'USD'。而
-- `ON CONFLICT DO NOTHING` **不能抑制 CHECK 违例**——PostgreSQL 先校验提议行，
-- 再处理冲突。于是重跑 0023 会直接撞新约束，而迁移必须是可重放的
-- （postgres-migration-runner 与恢复演练都会重跑）。
--
-- 改默认值而不是改 0023：改老迁移会让 checksum 漂移，
-- 所有已部署环境的迁移校验都会 fail-closed。
ALTER TABLE commercial_plan_versions ALTER COLUMN price_currency SET DEFAULT 'USDT';

ALTER TABLE commercial_plan_versions
  ADD CONSTRAINT commercial_plan_versions_price_currency_check
  CHECK (price_currency = 'USDT');
