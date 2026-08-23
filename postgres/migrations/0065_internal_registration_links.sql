-- V3 Operations 权限注册链接。
--
-- 旧 staff_reusable 邀请是 48 小时 + 待人工复核，不能通过放宽过期时间或改返回文案
-- 变成 V3 合同。新表把 token、目标角色、published role、权限快照和组织范围绑定为
-- 一个不可变 grant；注册只消费这个 grant，不允许注册者选择角色或扩大 scope。

CREATE TABLE IF NOT EXISTS internal_registration_links (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  issuer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role_id text NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  target_role text NOT NULL,
  organization_mode text NOT NULL,
  organization_id text REFERENCES organizations(id) ON DELETE RESTRICT,
  permission_snapshot_json jsonb NOT NULL,
  permission_snapshot_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  use_count bigint NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_registration_links_token_hash_shape
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT internal_registration_links_permission_hash_shape
    CHECK (permission_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT internal_registration_links_permission_snapshot_shape
    CHECK (
      jsonb_typeof(permission_snapshot_json) = 'array'
      AND jsonb_array_length(permission_snapshot_json) > 0
    ),
  CONSTRAINT internal_registration_links_target_role_check
    CHECK (target_role IN ('branch_admin', 'manager', 'supervisor', 'employee')),
  CONSTRAINT internal_registration_links_status_check
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT internal_registration_links_use_count_check
    CHECK (use_count >= 0),
  CONSTRAINT internal_registration_links_scope_shape
    CHECK (
      (
        target_role = 'branch_admin'
        AND organization_mode = 'CREATE_BRANCH'
        AND organization_id IS NULL
      )
      OR
      (
        target_role <> 'branch_admin'
        AND organization_mode = 'EXISTING_ORGANIZATION'
        AND organization_id IS NOT NULL
      )
    ),
  CONSTRAINT internal_registration_links_revocation_shape
    CHECK (
      (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
      OR
      (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
    )
);

-- 同一个生成者可以按不同角色、不同分公司各保留一条链接；同一 grant 只能有一条
-- active。NULL 组织只用于 CREATE_BRANCH，因此用空串归一不会和既有组织冲突。
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_registration_links_active_grant
  ON internal_registration_links (
    issuer_user_id,
    target_role,
    organization_mode,
    COALESCE(organization_id, '')
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_internal_registration_links_issuer_status
  ON internal_registration_links (issuer_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS internal_registration_link_uses (
  id text PRIMARY KEY,
  link_id text NOT NULL REFERENCES internal_registration_links(id) ON DELETE RESTRICT,
  registered_user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_internal_registration_link_uses_link_time
  ON internal_registration_link_uses (link_id, used_at DESC);

CREATE OR REPLACE FUNCTION protect_internal_registration_link_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_APPEND_ONLY';
  END IF;

  IF OLD.token_hash IS DISTINCT FROM NEW.token_hash
    OR OLD.issuer_user_id IS DISTINCT FROM NEW.issuer_user_id
    OR OLD.role_id IS DISTINCT FROM NEW.role_id
    OR OLD.target_role IS DISTINCT FROM NEW.target_role
    OR OLD.organization_mode IS DISTINCT FROM NEW.organization_mode
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.permission_snapshot_json IS DISTINCT FROM NEW.permission_snapshot_json
    OR OLD.permission_snapshot_sha256 IS DISTINCT FROM NEW.permission_snapshot_sha256
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_CONTRACT_IMMUTABLE';
  END IF;

  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_REACTIVATION_FORBIDDEN';
  END IF;
  IF OLD.status = 'revoked' AND (
    OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
    OR OLD.revoked_by_user_id IS DISTINCT FROM NEW.revoked_by_user_id
  ) THEN
    RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_REVOCATION_IMMUTABLE';
  END IF;
  IF NEW.use_count < OLD.use_count
    OR (
      OLD.last_used_at IS NOT NULL
      AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)
    ) THEN
    RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_USAGE_MONOTONIC';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS internal_registration_links_contract_guard
  ON internal_registration_links;
CREATE TRIGGER internal_registration_links_contract_guard
BEFORE UPDATE OR DELETE ON internal_registration_links
FOR EACH ROW EXECUTE FUNCTION protect_internal_registration_link_contract();

CREATE OR REPLACE FUNCTION protect_internal_registration_link_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
  old_role_id text;
  new_role_id text;
BEGIN
  IF TG_TABLE_NAME = 'roles' THEN
    old_role_id := OLD.id;
  ELSIF TG_OP = 'INSERT' THEN
    new_role_id := NEW.role_id;
  ELSIF TG_OP = 'DELETE' THEN
    old_role_id := OLD.role_id;
  ELSE
    old_role_id := OLD.role_id;
    new_role_id := NEW.role_id;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM internal_registration_links
     WHERE role_id = old_role_id OR role_id = new_role_id
  ) THEN
    RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_ROLE_IMMUTABLE';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

DROP TRIGGER IF EXISTS internal_registration_link_roles_guard ON roles;
CREATE TRIGGER internal_registration_link_roles_guard
BEFORE UPDATE OR DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION protect_internal_registration_link_role();

DROP TRIGGER IF EXISTS internal_registration_link_permissions_guard ON role_permissions;
CREATE TRIGGER internal_registration_link_permissions_guard
BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
FOR EACH ROW EXECUTE FUNCTION protect_internal_registration_link_role();

CREATE OR REPLACE FUNCTION protect_internal_registration_link_use()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'INTERNAL_REGISTRATION_LINK_USE_APPEND_ONLY';
END
$function$;

DROP TRIGGER IF EXISTS internal_registration_link_uses_append_only
  ON internal_registration_link_uses;
CREATE TRIGGER internal_registration_link_uses_append_only
BEFORE UPDATE OR DELETE ON internal_registration_link_uses
FOR EACH ROW EXECUTE FUNCTION protect_internal_registration_link_use();

COMMENT ON TABLE internal_registration_links IS
  'V3 Operations 权限注册链接。目标角色、published role、权限快照和组织范围创建后不可变。';
COMMENT ON TABLE internal_registration_link_uses IS
  '每次成功自助注册的追加式使用事实；失败尝试进入安全审计与限流证据。';
