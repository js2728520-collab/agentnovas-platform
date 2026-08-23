-- 内部账号的客户身份，排除在业绩归因与分成基准之外。
--
-- 公司人员要熟悉业务，就需要一个真实的客户账号。但那个账号一旦进了归因体系，
-- 就出现一个可以自我刷单的口子：员工用自己的邀请链接注册，他的仓位算成他自己的
-- 业绩，他的主管、经理、分公司跟着一路分成。
--
-- 数据库层没有「内部账号」这个概念，所以在这里加一个显式标记，而不是靠约定
-- （比如「邮箱后缀是公司域名就算内部」——那种规则第一次遇到用私人邮箱的员工就失效）。

ALTER TABLE customer_attributions
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

-- 内部账号必须写明是谁的、为什么。
--
-- 一个没有说明的 is_internal=true 等于一个可以随手把任何客户移出业绩口径的开关，
-- 那正是它本身会被滥用的方式。
ALTER TABLE customer_attributions
  ADD COLUMN IF NOT EXISTS internal_owner_user_id text,
  ADD COLUMN IF NOT EXISTS internal_reason text;

ALTER TABLE customer_attributions DROP CONSTRAINT IF EXISTS customer_attributions_internal_is_explained;
ALTER TABLE customer_attributions
  ADD CONSTRAINT customer_attributions_internal_is_explained
  CHECK (
    is_internal = false
    OR (internal_owner_user_id IS NOT NULL AND internal_reason IS NOT NULL AND length(btrim(internal_reason)) > 0)
  );

-- 业绩统计与分成的热路径都要过滤这个标记，给它一个索引。
CREATE INDEX IF NOT EXISTS idx_customer_attributions_countable
  ON customer_attributions (employee_id, status)
  WHERE is_internal = false;

COMMENT ON COLUMN customer_attributions.is_internal IS
  '内部员工的体验账号。不计入任何业绩归因、团队目标或绩效分成基准。';
