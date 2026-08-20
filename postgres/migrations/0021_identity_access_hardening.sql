-- Identity and access controls for the controlled beta.
-- This migration is additive and idempotent. Runtime code owns all state changes.

CREATE TABLE IF NOT EXISTS "auth_rate_limit_buckets" (
  "id" text PRIMARY KEY,
  "action" text NOT NULL CHECK ("action" IN (
    'login', 'forgot_password', 'reset_password', 'mfa_verify', 'bootstrap'
  )),
  "app_audience" text NOT NULL CHECK ("app_audience" IN (
    'client', 'operations', 'maintenance'
  )),
  "bucket_key_hash" text NOT NULL,
  "window_started_at" timestamptz NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "blocked_until" timestamptz,
  "last_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("action", "app_audience", "bucket_key_hash")
);

CREATE INDEX IF NOT EXISTS "idx_auth_rate_limit_blocked_until"
  ON "auth_rate_limit_buckets" ("blocked_until")
  WHERE "blocked_until" IS NOT NULL;

ALTER TABLE "auth_tokens"
  ADD COLUMN IF NOT EXISTS "token_audience" text NOT NULL DEFAULT 'client';

UPDATE "auth_tokens" AS token
SET "token_audience" = 'operations'
FROM "users" AS user_account
WHERE token.user_id = user_account.id
  AND token.purpose = 'reset_password'
  AND token.used_at IS NULL
  AND user_account.role <> 'customer'
  AND user_account.status = 'pending'
  AND token.token_audience = 'client';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_tokens_audience_check'
      AND conrelid = 'auth_tokens'::regclass
  ) THEN
    ALTER TABLE "auth_tokens"
      ADD CONSTRAINT auth_tokens_audience_check
      CHECK ("token_audience" IN ('client', 'operations', 'maintenance'));
  END IF;
END $$;

-- Purge bearer tokens queued by pre-hardening builds. They cannot be safely
-- transformed in SQL because the application encryption key is intentionally
-- unavailable to migrations; users can request a fresh link after deploy.
UPDATE "notification_deliveries"
SET "status" = 'failed',
    "payload_json" = '{}',
    "last_error" = 'LEGACY_PLAINTEXT_TOKEN_PURGED',
    "lease_owner" = NULL,
    "lease_expires_at" = NULL,
    "updated_at" = now()
WHERE "template_key" IN ('reset_password', 'internal_account_invite')
  AND "payload_json" ~ '"token"[[:space:]]*:';

CREATE TABLE IF NOT EXISTS "user_mfa_totp_credentials" (
  "user_id" text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "encrypted_secret" text NOT NULL,
  "encryption_key_version" integer NOT NULL DEFAULT 1 CHECK ("encryption_key_version" > 0),
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'active', 'disabled')),
  "last_accepted_counter" bigint,
  "enabled_at" timestamptz,
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user_mfa_recovery_codes" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "code_hash")
);

CREATE INDEX IF NOT EXISTS "idx_user_mfa_recovery_codes_available"
  ON "user_mfa_recovery_codes" ("user_id", "created_at")
  WHERE "used_at" IS NULL;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "mfa_level" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "mfa_verified_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "idle_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "absolute_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "session_version" bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_mfa_level_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT sessions_mfa_level_check
      CHECK ("mfa_level" IN ('none', 'primary', 'totp', 'recovery'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_assurance_expiry_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT sessions_assurance_expiry_check
      CHECK (
        "idle_expires_at" IS NULL OR
        "absolute_expires_at" IS NULL OR
        "idle_expires_at" <= "absolute_expires_at"
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_version_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT sessions_version_check CHECK ("session_version" > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_sessions_active_assurance"
  ON "sessions" ("user_id", "app_audience", "absolute_expires_at", "idle_expires_at")
  WHERE "revoked_at" IS NULL;

ALTER TABLE "user_role_assignments"
  ADD COLUMN IF NOT EXISTS "scope_organization_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "scope_version" bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_role_assignments_scope_organizations_array_check'
      AND conrelid = 'user_role_assignments'::regclass
  ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT user_role_assignments_scope_organizations_array_check
      CHECK (
        jsonb_typeof("scope_organization_ids_json") = 'array' AND
        jsonb_array_length("scope_organization_ids_json") <= 64
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_role_assignments_expiry_check'
      AND conrelid = 'user_role_assignments'::regclass
  ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT user_role_assignments_expiry_check
      CHECK ("expires_at" IS NULL OR "expires_at" > "effective_at");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_role_assignments_scope_version_check'
      AND conrelid = 'user_role_assignments'::regclass
  ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT user_role_assignments_scope_version_check CHECK ("scope_version" > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "rbac_revocation_tombstones" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "revoked_assignment_id" text REFERENCES "user_role_assignments"("id") ON DELETE SET NULL,
  "revoked_role_id" text REFERENCES "roles"("id") ON DELETE SET NULL,
  "revoked_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "revoked_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "application_id")
);

CREATE INDEX IF NOT EXISTS "idx_rbac_revocation_tombstones_application"
  ON "rbac_revocation_tombstones" ("application_id", "revoked_at" DESC);

-- Commercial beta permissions are deliberately split by maker/checker action.
-- In particular, evidence capture, approval, and emergency actions must not
-- inherit the broad reconciliation permission.
INSERT INTO "permission_definitions" ("key", "application_id", "label", "sensitive", "status")
VALUES
  ('client.membership.view', 'client', '查看会员权益', false, 'active'),
  ('client.membership.order', 'client', '提交会员订单', true, 'active'),
  ('client.credits.view', 'client', '查看积分余额', false, 'active'),
  ('client.paper.view', 'client', '查看模拟交易', false, 'active'),
  ('ops.membership_orders.view', 'operations', '查看会员订单', false, 'active'),
  ('ops.membership_orders.evidence', 'operations', '录入会员付款凭证', true, 'active'),
  ('ops.membership_orders.approve', 'operations', '审批会员订单', true, 'active'),
  ('ops.credits.view', 'operations', '查看客户积分', false, 'active'),
  ('ops.credits.adjust', 'operations', '发起积分调整', true, 'active'),
  ('ops.credits.approve', 'operations', '审批积分调整', true, 'active'),
  ('ops.performance_fees.view', 'operations', '查看绩效费账单', false, 'active'),
  ('ops.performance_fees.generate', 'operations', '生成绩效费账单', true, 'active'),
  ('ops.performance_fees.approve', 'operations', '审批绩效费账单', true, 'active'),
  ('ops.performance_fees.payment_evidence', 'operations', '录入绩效费付款凭证', true, 'active'),
  ('ops.performance_fees.payment_approve', 'operations', '审批绩效费付款', true, 'active'),
  ('ops.approvals.view', 'operations', '查看审批中心', false, 'active'),
  ('ops.approvals.decide', 'operations', '处理审批', true, 'active'),
  ('ops.attributions.manage', 'operations', '管理客户归属', true, 'active'),
  ('ops.finance.manage', 'operations', '执行财务操作', true, 'active'),
  ('ops.invitations.view', 'operations', '查看邀请码', false, 'active'),
  ('ops.invitations.manage', 'operations', '创建邀请码', true, 'active'),
  ('ops.organization.view', 'operations', '查看组织成员', false, 'active'),
  ('ops.organization.manage', 'operations', '管理组织成员', true, 'active'),
  ('ops.team.view', 'operations', '查看团队运营数据', false, 'active'),
  ('ops.team.manage', 'operations', '管理团队运营数据', true, 'active'),
  ('maint.follow_policy.view', 'maintenance', '查看跟随策略规则', false, 'active'),
  ('maint.follow_policy.manage', 'maintenance', '管理跟随策略规则', true, 'active'),
  ('maint.demo_exchanges.view', 'maintenance', '查看模拟交易所', false, 'active'),
  ('maint.demo_exchanges.manage', 'maintenance', '管理模拟交易所', true, 'active'),
  ('maint.demo_exchanges.verify', 'maintenance', '验证模拟交易所', true, 'active'),
  ('maint.demo_exchanges.kill', 'maintenance', '紧急停止模拟交易所', true, 'active')
ON CONFLICT ("key") DO UPDATE SET
  "application_id" = EXCLUDED."application_id",
  "label" = EXCLUDED."label",
  "sensitive" = EXCLUDED."sensitive",
  "status" = EXCLUDED."status",
  "updated_at" = now();
