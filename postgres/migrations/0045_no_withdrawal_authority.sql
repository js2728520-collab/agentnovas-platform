-- 平台永不持有客户交易所账户的提现权限。
--
-- 背景：此前 lib/follow-policy.ts 要求客户开通提现授权才能跟单，目的是自动扣绩效
-- 分成。提现权限是交易所 API 密钥的最高权限——拿到它就能把账户里的钱转走。
-- 为 N 个客户保管带提现权限的密钥意味着：执行主机被攻破一次 = 全部客户资金
-- 可被直接转出。这会把「非托管」实质变回托管风险，尽管资金确实在客户账户里。
--
-- 决策：绩效分成改为从客户预充的服务余额扣除，走已有的优盾充值 + ledger_accounts
-- + performance_fee_receivables + maker/checker 复核路径。密钥只需读 + 交易权限。
--
-- 同一张表此前还存在自相矛盾的要求：follow-policy 要求必须有提现权限，而
-- research-exchange-account.ts 与 perpetual-instruments 接口要求必须没有提现权限，
-- 客户无法同时满足。本迁移统一到「禁止」这一侧。

-- 1. 清理历史值。Beta 期实盘跟单从未开启，正常情况下这里是 0 行。
UPDATE exchange_accounts
   SET withdrawal_authorized = 0,
       withdrawal_credential_ref = NULL
 WHERE withdrawal_authorized <> 0
    OR withdrawal_credential_ref IS NOT NULL;

-- 2. 数据库层面禁止。不 DROP 列：保留字段可以让「曾经存在过这个概念」在 schema
--    里留痕，而 CHECK 让它永远为假。绕过应用层直接写 SQL 也写不进去。
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'exchange_accounts'::regclass
       AND conname = 'exchange_accounts_no_withdrawal_authority'
  ) THEN
    ALTER TABLE exchange_accounts
      ADD CONSTRAINT exchange_accounts_no_withdrawal_authority
      CHECK (withdrawal_authorized = 0 AND withdrawal_credential_ref IS NULL);
  END IF;
END $$;

-- 3. platform_follow_policies.allow_follow_without_withdrawal 的语义随之作废：
--    提现授权已不再是可选项，「允许未开启提现授权的账户跟随」永远为真。
UPDATE platform_follow_policies SET allow_follow_without_withdrawal = 1
 WHERE allow_follow_without_withdrawal <> 1;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'platform_follow_policies'::regclass
       AND conname = 'platform_follow_policies_withdrawal_obsolete'
  ) THEN
    ALTER TABLE platform_follow_policies
      ADD CONSTRAINT platform_follow_policies_withdrawal_obsolete
      CHECK (allow_follow_without_withdrawal = 1);
  END IF;
END $$;
