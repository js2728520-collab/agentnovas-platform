-- 员工邀请链接：可复用 + 48 小时有效 + 双人复核。
--
-- 与客户链接的关键区别是**有效期**和**审批**，而不是能不能复用。
--
-- 为什么员工链接必须有期限，而客户链接不需要：拿到客户链接的人最多注册成一个客户，
-- 只能看到自己的数据；拿到员工链接的人会进入组织架构，能看到名下客户的资料、
-- 发起充值人工操作、调整归属。同一条链接永久有效意味着一次转发就是永久的入口。
--
-- 48 小时把窗口收窄，双人复核则保证即使链接在窗口内外泄，多出来的账号也只能停在
-- 待批准状态——真正的闸门是复核人，期限只是把他要审的量控制住。

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS expires_at text,
  -- 通过这条链接注册的人成为什么角色。由生成链接的人的下一级推出，不可自选。
  ADD COLUMN IF NOT EXISTS target_role text;

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_kind_check;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_kind_check
  CHECK (kind IN ('employee_reusable', 'public_pool_single_use', 'staff_reusable'));

-- 员工链接必须有期限与目标角色；客户链接必须都没有。
--
-- 把「有没有期限」做成 kind 的函数而不是可选项：一条忘了设期限的员工链接
-- 与永久链接没有区别，而那正是这次要避免的。
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_staff_link_shape;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_staff_link_shape
  CHECK (
    (kind = 'staff_reusable' AND expires_at IS NOT NULL AND target_role IS NOT NULL AND owner_employee_id IS NOT NULL)
    OR (kind <> 'staff_reusable' AND expires_at IS NULL AND target_role IS NULL)
  );

-- 0055 的唯一索引只覆盖 employee_reusable。员工链接同样一人一条，
-- 否则「重新生成」不会让旧链接失效。
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_active_staff_owner
  ON invitations (owner_employee_id)
  WHERE kind = 'staff_reusable' AND status = 'active';

-- 0055 的归属人约束当时只认两种 kind，现在要放行第三种。
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_owner_matches_kind;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_owner_matches_kind
  CHECK (
    (kind IN ('employee_reusable', 'staff_reusable') AND owner_employee_id IS NOT NULL)
    OR (kind = 'public_pool_single_use' AND owner_employee_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_invitations_staff_expiry
  ON invitations (expires_at)
  WHERE kind = 'staff_reusable' AND status = 'active';
