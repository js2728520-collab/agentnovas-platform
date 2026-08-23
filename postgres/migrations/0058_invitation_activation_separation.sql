-- 记录成员是通过谁的邀请链接注册的，用于把「邀请」与「激活」分给两个人。
--
-- canManuallyActivateMember 只挡「激活自己」，不挡「激活自己邀请的人」。对手工录入
-- 的路径影响不大（上级本来就知道自己录了谁），但对链接注册是致命的：生成链接的人
-- 同时批准通过链接进来的人，等于一个人走完全程，双人复核名存实亡。
--
-- reports_to_user_id 不能替代这个字段：它表达的是长期汇报关系，而「谁邀请的」是
-- 一次性事实。两者在链接注册时恰好相同，但汇报关系会调整，事实不会变。

ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_via_invitation_id text;

CREATE INDEX IF NOT EXISTS idx_users_invited_via_invitation
  ON users (invited_via_invitation_id)
  WHERE invited_via_invitation_id IS NOT NULL;

COMMENT ON COLUMN users.invited_via_invitation_id IS
  '通过邀请链接注册时的链接 id。激活该账号的人不得是该链接的归属人（双人复核）。';
