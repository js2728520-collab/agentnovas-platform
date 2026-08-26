-- 对账结案时记下手续费。
--
-- 适配器的 getOrderByClientOrderId 一直返回 feeAmount，但它在对账 Worker 里被丢掉，
-- 结案事实只保留了成交量与均价。
--
-- 平时无所谓——回执里已经有下单响应带回的费用。**但对账存在的全部理由，就是回执
-- 可能是错的**：市价单在响应之后才成交时，回执停在 rejected（费用 0），而真实成交
-- 是有手续费的。这时对账是费用的唯一来源。
--
-- 缺了它只能按 0 记账，方向是：费用记少 → 净利记多 → 高水位线绩效分成多收。
-- 错误方向偏向平台自己，这是最不该出现的那一种（INV-5）。

ALTER TABLE execution_reconciliations
  ADD COLUMN IF NOT EXISTS fee_amount double precision;

ALTER TABLE execution_reconciliations DROP CONSTRAINT IF EXISTS execution_reconciliations_fee_amount_check;
ALTER TABLE execution_reconciliations
  ADD CONSTRAINT execution_reconciliations_fee_amount_check
  CHECK (fee_amount IS NULL OR fee_amount >= 0);

-- 已有的 resolved 记录补 0。
--
-- 这里断言的是「这些历史记录的手续费确实是 0」，不是「不知道就填 0」——两者
-- 差别很大。实盘从未开通过（五处 fail-closed 一直挡着），这张表里只可能有 demo
-- 环境的订单，demo 不产生真实手续费。
--
-- 如果将来在有真实成交之后再加类似约束，正确做法是回交易所补查，而不是填 0。
UPDATE execution_reconciliations SET fee_amount = 0
WHERE status = 'resolved' AND fee_amount IS NULL;

-- 结案且判为成交的记录必须带费用。判为未成交（rejected/expired）时费用恒为 0，
-- 也要显式写 0 而不是留空——留空与「不知道」无法区分。
ALTER TABLE execution_reconciliations DROP CONSTRAINT IF EXISTS execution_reconciliations_resolved_has_fee;
ALTER TABLE execution_reconciliations
  ADD CONSTRAINT execution_reconciliations_resolved_has_fee
  CHECK (status <> 'resolved' OR fee_amount IS NOT NULL);
