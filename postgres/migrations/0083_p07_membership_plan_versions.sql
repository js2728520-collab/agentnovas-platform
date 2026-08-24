-- P-07 定价收口（需求方 2026-08-24 冻结）。
--
-- 此前有两份互相矛盾的「唯一真源」：`packages/contracts/src/commercial-beta.ts`
-- （月 28 / 季 58 / 年 198 / 终身 588，费率 0.20/0.20/0.20/0.16）与需求方确认单里的 P-07
-- （59 / 129 / 499 / 1999，费率 0.20/0.19/0.18/0.16）。需求方裁定以 P-07 为准。
--
-- **改价不改历史（INV-5）。** 不就地改 v1 那四行——已激活的会员订单通过
-- `plan_version_id` 外键指向它们，就地改会静默改写所有历史订单当初的价格与费率。正确
-- 做法是把 v1 标 retired 并新建 v2；`idx_commercial_plan_one_active` 保证同一时刻每个套餐
-- 只有一个 active 版本。

UPDATE commercial_plan_versions
   SET status = 'retired'
 WHERE plan_code IN ('monthly_v1','quarterly_v1','annual_v1','lifetime_v1')
   AND version = 1
   AND status = 'active';

INSERT INTO commercial_plan_versions
  (id, plan_code, version, price_amount, duration_days, ai_credit_grant, performance_fee_bps, status, effective_at)
VALUES
  ('membership_monthly_v2','monthly_v1',2,59,30,1000,2000,'active','2026-08-24T00:00:00Z'),
  ('membership_quarterly_v2','quarterly_v1',2,129,90,3000,1900,'active','2026-08-24T00:00:00Z'),
  ('membership_annual_v2','annual_v1',2,499,365,12000,1800,'active','2026-08-24T00:00:00Z'),
  ('membership_lifetime_v2','lifetime_v1',2,1999,NULL,36000,1600,'active','2026-08-24T00:00:00Z')
ON CONFLICT (plan_code, version) DO NOTHING;
