-- 实盘成交落进账本。
--
-- 补的是 LIVE_EXECUTION_BLOCKERS 前三条的共同根因：实盘成交没有进账本。
-- 仓位、风控读数、绩效分成三者都读账本，账本上没有实盘成交，三者就同时是错的
-- ——而且都不报错。

-- 每一笔实盘意图在账本上只能落一次。
--
-- Worker 崩溃重启会重放同一轮决策（INV-8），重复记账会凭空复制客户的仓位：
-- 账上两份、交易所一份，之后按账上的量去平仓，会卖掉一个不存在的仓位。
CREATE TABLE IF NOT EXISTS live_book_postings (
  id text PRIMARY KEY,
  intent_id text NOT NULL UNIQUE,
  deployment_id text NOT NULL,
  portfolio_id text NOT NULL REFERENCES official_paper_portfolios(id) ON DELETE CASCADE,

  -- 未成交（拒绝/过期）的意图也在这里留一行，fill_receipt_id 为空。
  -- 没有这一行的话，它们会被反复取出来重新判定。
  fill_receipt_id text REFERENCES official_paper_fill_receipts(id),

  -- 事实取自下单回执还是对账结案。客户的执行说明要能讲清这一点（INV-8）。
  fact_source text NOT NULL CHECK (fact_source IN ('receipt', 'reconciliation')),
  outcome text NOT NULL CHECK (outcome IN ('filled', 'partial', 'rejected', 'expired')),

  -- 对账推翻了下单回执。运营端要能把这些单挑出来复核——它们是执行链路出问题的信号。
  contradicts_receipt boolean NOT NULL DEFAULT false,

  settled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- 判为成交就必须有账本回执，判为未成交就必须没有。
  -- 少了这条，一笔「记成 filled 却没落账」的记录会让仓位凭空消失且无人发现。
  CONSTRAINT live_book_postings_receipt_matches_outcome CHECK (
    (outcome IN ('filled', 'partial')) = (fill_receipt_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_live_book_postings_deployment
  ON live_book_postings (deployment_id, settled_at DESC);

-- 被对账推翻的单要能一眼捞出来。
CREATE INDEX IF NOT EXISTS idx_live_book_postings_contradictions
  ON live_book_postings (settled_at DESC) WHERE contradicts_receipt;

-- 账本记录不可改写，与它两侧的 official_paper_* 表一致。
CREATE OR REPLACE FUNCTION reject_live_book_posting_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'live book postings are append-only';
END $$;

DROP TRIGGER IF EXISTS trg_live_book_postings_immutable ON live_book_postings;
CREATE TRIGGER trg_live_book_postings_immutable
BEFORE UPDATE OR DELETE ON live_book_postings
FOR EACH ROW EXECUTE FUNCTION reject_live_book_posting_mutation();

-- 实盘成交必须能回指一轮决策。
--
-- 账本上的成交回执要求 intent_id 指向一条 official_paper_order_intents，而那张表的
-- runtime_cycle_id 是 NOT NULL。与其在记账时容忍一个空值，不如让这里成为硬约束：
-- 一笔没有决策轮溯源的真实成交，本身就该被拦下来查，而不是记进账（INV-8）。
--
-- 将来若要支持运维手动平仓那类没有决策轮的下单，会在这条约束上撞停——那正是
-- 应该显式做决定的地方，而不是让它悄悄写进一个可空字段。
ALTER TABLE live_execution_receipts ALTER COLUMN runtime_cycle_id SET NOT NULL;

-- 实盘下的是市价单，既不是「下一根 K 线开盘」也不是「盘中触发」。
-- 沿用其中一个会让账本上的成交时点说谎。
ALTER TABLE official_paper_order_intents DROP CONSTRAINT IF EXISTS official_paper_order_intents_execution_timing_check;
ALTER TABLE official_paper_order_intents
  ADD CONSTRAINT official_paper_order_intents_execution_timing_check
  CHECK (execution_timing IN ('next_candle_open', 'intrabar_threshold', 'live_market'));
