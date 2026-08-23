-- 可复用邀请链接。
--
-- `employee_reusable` 这个 kind 早就存在，行为也正是「创建一次、反复使用」：
-- client_claim_registration_invitation 只把 public_pool_single_use 标记为 used，
-- 可复用的那种用完仍是 active。owner_employee_id 还会被注册时的递归 CTE 用来沿
-- reports_to_user_id 往上走，把新客户挂进整条汇报链做归因。
--
-- 缺的是三件事，本迁移解决其中两件：
--   1. 一个人可以建出 N 条有效链接，而「我的邀请链接」应该只有一条；
--   2. 没有任何地方记录这条链接被用过多少次；
--   3. 界面与链接形式（在应用层解决）。

-- 一人一条有效的可复用链接。
--
-- 没有它，重新生成时旧链接不会失效——而「重新生成」的全部意义就是让旧链接失效
-- （链接会被转发到群里、截图、贴进文档，旧链接继续有效等于撤销无效）。
-- 有了这条唯一约束，重新生成就必须先把旧的置为 revoked，做不到偷懒。
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_active_reusable_owner
  ON invitations (owner_employee_id)
  WHERE kind = 'employee_reusable' AND status = 'active';

-- 使用计数与最近一次使用时间。
--
-- 可复用链接不会被标记为 used，所以此前完全无法回答「这条链接带来了多少注册」。
-- 运营需要它来判断链接是否已经外泄（比如一条本该发给三五个人的链接突然涨到几百次）。
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS last_used_at text;

-- 撤销记录。revoked 与 used 是两回事：used 是「一次性码被消费」，
-- revoked 是「这条链接被主动作废」。混用会让审计说不清链接是怎么失效的。
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS revoked_at text;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS revoked_by_user_id text;

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_status_check;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_status_check
  CHECK (status IN ('active', 'used', 'revoked'));

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_revoked_is_recorded;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_revoked_is_recorded
  CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL));

-- 可复用链接必须有归属人；一次性码必须没有。
-- 归属人就是「是谁邀请的」这个问题的答案，缺了它归因链无从起步。
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_owner_matches_kind;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_owner_matches_kind
  CHECK (
    (kind = 'employee_reusable' AND owner_employee_id IS NOT NULL)
    OR (kind = 'public_pool_single_use' AND owner_employee_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_invitations_owner_active
  ON invitations (owner_employee_id, status)
  WHERE kind = 'employee_reusable';
