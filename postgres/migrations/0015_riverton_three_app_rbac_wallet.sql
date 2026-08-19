ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "app_audience" text NOT NULL DEFAULT 'client';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_app_audience_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT sessions_app_audience_check
      CHECK ("app_audience" IN ('client', 'operations', 'maintenance'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_sessions_user_app_expiry"
  ON "sessions" ("user_id", "app_audience", "expires_at");

CREATE TABLE IF NOT EXISTS "applications" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "domain" text NOT NULL,
  "local_port" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'disabled')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "permission_definitions" (
  "key" text PRIMARY KEY,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE RESTRICT,
  "label" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "sensitive" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'deprecated', 'disabled')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "role_templates" (
  "id" text PRIMARY KEY,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE RESTRICT,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "owner_organization_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'published', 'disabled')),
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("application_id", "code")
);

CREATE TABLE IF NOT EXISTS "role_template_versions" (
  "id" text PRIMARY KEY,
  "template_id" text NOT NULL REFERENCES "role_templates"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL CHECK ("version" > 0),
  "permissions_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "change_summary" text NOT NULL DEFAULT '',
  "published_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("template_id", "version")
);

CREATE TABLE IF NOT EXISTS "roles" (
  "id" text PRIMARY KEY,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE RESTRICT,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('system', 'custom', 'derived')),
  "created_organization_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "applies_to_organization_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "parent_template_id" text REFERENCES "role_templates"("id") ON DELETE RESTRICT,
  "parent_template_version_id" text REFERENCES "role_template_versions"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'published', 'disabled')),
  "is_system" boolean NOT NULL DEFAULT false,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("application_id", "code")
);

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id" text PRIMARY KEY,
  "role_id" text NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "permission_key" text NOT NULL REFERENCES "permission_definitions"("key") ON DELETE RESTRICT,
  "scope" text NOT NULL CHECK ("scope" IN ('SELF', 'DIRECT_REPORTS', 'TEAM_TREE', 'ORGANIZATION', 'ORGANIZATION_SET', 'PLATFORM')),
  "scope_organization_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("role_id", "permission_key")
);

CREATE INDEX IF NOT EXISTS "idx_role_permissions_permission"
  ON "role_permissions" ("permission_key", "scope");

CREATE TABLE IF NOT EXISTS "user_role_assignments" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" text NOT NULL REFERENCES "roles"("id") ON DELETE RESTRICT,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE RESTRICT,
  "organization_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('pending', 'active', 'revoked', 'expired')),
  "effective_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "granted_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "revoked_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "revoked_at" timestamptz,
  "reason" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_user_role_assignments_effective"
  ON "user_role_assignments" ("user_id", "application_id", "status", "effective_at", "expires_at");

CREATE TABLE IF NOT EXISTS "access_change_requests" (
  "id" text PRIMARY KEY,
  "application_id" text NOT NULL REFERENCES "applications"("id") ON DELETE RESTRICT,
  "target_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "target_role_id" text REFERENCES "roles"("id") ON DELETE SET NULL,
  "change_type" text NOT NULL CHECK ("change_type" IN ('role_create', 'role_update', 'role_assign', 'role_revoke', 'template_publish')),
  "before_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "after_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
  "requested_by_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "reason" text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS "idx_access_change_requests_status"
  ON "access_change_requests" ("application_id", "status", "requested_at");

CREATE TABLE IF NOT EXISTS "access_change_decisions" (
  "id" text PRIMARY KEY,
  "request_id" text NOT NULL REFERENCES "access_change_requests"("id") ON DELETE CASCADE,
  "reviewer_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL CHECK ("decision" IN ('approve', 'reject')),
  "note" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("request_id", "reviewer_user_id")
);

CREATE TABLE IF NOT EXISTS "authorization_audit_events" (
  "id" text PRIMARY KEY,
  "actor_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "application_id" text REFERENCES "applications"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "before_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "after_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_authorization_audit_subject"
  ON "authorization_audit_events" ("subject_type", "subject_id", "created_at");

CREATE TABLE IF NOT EXISTS "ledger_accounts" (
  "id" text PRIMARY KEY,
  "owner_user_id" text REFERENCES "users"("id") ON DELETE RESTRICT,
  "owner_organization_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "account_type" text NOT NULL CHECK ("account_type" IN (
    'user_available', 'user_frozen', 'platform_deposit_clearing',
    'platform_fee', 'refund_pending', 'manual_adjustment'
  )),
  "currency" text NOT NULL DEFAULT 'USDT',
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'closed')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("owner_user_id", "account_type", "currency")
);

CREATE TABLE IF NOT EXISTS "ledger_transactions" (
  "id" text PRIMARY KEY,
  "transaction_type" text NOT NULL CHECK ("transaction_type" IN (
    'deposit_credit', 'membership_purchase', 'ai_credit_purchase',
    'freeze', 'unfreeze', 'return_reserve', 'return_confirmed', 'correction'
  )),
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "currency" text NOT NULL DEFAULT 'USDT',
  "status" text NOT NULL DEFAULT 'posted' CHECK ("status" IN ('posted', 'reversed')),
  "idempotency_key" text NOT NULL,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("idempotency_key")
);

CREATE INDEX IF NOT EXISTS "idx_ledger_transactions_source"
  ON "ledger_transactions" ("source_type", "source_id");

CREATE TABLE IF NOT EXISTS "ledger_postings" (
  "id" text PRIMARY KEY,
  "transaction_id" text NOT NULL REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "account_id" text NOT NULL REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT,
  "side" text NOT NULL CHECK ("side" IN ('debit', 'credit')),
  "amount" numeric(36, 18) NOT NULL CHECK ("amount" > 0),
  "currency" text NOT NULL DEFAULT 'USDT',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_ledger_postings_account"
  ON "ledger_postings" ("account_id", "created_at");

CREATE TABLE IF NOT EXISTS "wallet_balances" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "currency" text NOT NULL DEFAULT 'USDT',
  "available_amount" numeric(36, 18) NOT NULL DEFAULT 0 CHECK ("available_amount" >= 0),
  "frozen_amount" numeric(36, 18) NOT NULL DEFAULT 0 CHECK ("frozen_amount" >= 0),
  "version" bigint NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "currency")
);

CREATE TABLE IF NOT EXISTS "wallet_balance_versions" (
  "id" text PRIMARY KEY,
  "wallet_balance_id" text NOT NULL REFERENCES "wallet_balances"("id") ON DELETE CASCADE,
  "ledger_transaction_id" text NOT NULL REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "available_amount" numeric(36, 18) NOT NULL CHECK ("available_amount" >= 0),
  "frozen_amount" numeric(36, 18) NOT NULL CHECK ("frozen_amount" >= 0),
  "version" bigint NOT NULL CHECK ("version" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("wallet_balance_id", "version")
);

CREATE TABLE IF NOT EXISTS "payment_provider_configs" (
  "id" text PRIMARY KEY,
  "provider" text NOT NULL,
  "channel" text NOT NULL CHECK ("channel" IN ('on_chain', 'third_party', 'bank_card', 'manual')),
  "network" text CHECK ("network" IN ('TRC20', 'ERC20', 'BEP20')),
  "status" text NOT NULL DEFAULT 'disabled' CHECK ("status" IN ('sandbox', 'active', 'disabled')),
  "confirmation_threshold" integer CHECK ("confirmation_threshold" IS NULL OR "confirmation_threshold" > 0),
  "settings_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "encrypted_secret_ref" text,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("provider", "channel", "network")
);

CREATE TABLE IF NOT EXISTS "deposit_orders" (
  "id" text PRIMARY KEY,
  "platform_order_no" text NOT NULL UNIQUE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "branch_id" text REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "currency" text NOT NULL DEFAULT 'USDT',
  "network" text CHECK ("network" IN ('TRC20', 'ERC20', 'BEP20')),
  "expected_amount" numeric(36, 18),
  "actual_amount" numeric(36, 18),
  "usdt_value" numeric(36, 18),
  "fiat_currency" text,
  "fiat_value" numeric(36, 18),
  "fee_amount" numeric(36, 18) NOT NULL DEFAULT 0,
  "credited_amount" numeric(36, 18) NOT NULL DEFAULT 0,
  "channel" text NOT NULL CHECK ("channel" IN ('on_chain', 'third_party', 'bank_card', 'manual')),
  "provider" text,
  "provider_order_id" text,
  "provider_event_id" text,
  "source_address" text,
  "deposit_address" text,
  "tx_id" text,
  "tx_index" integer,
  "confirmations" integer NOT NULL DEFAULT 0 CHECK ("confirmations" >= 0),
  "required_confirmations" integer,
  "order_status" text NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK ("order_status" IN ('PENDING_CONFIRMATION', 'CONFIRMING', 'MANUAL_REVIEW', 'CREDITED', 'FAILED', 'RETURNED')),
  "funds_status" text NOT NULL DEFAULT 'NOT_CREDITED' CHECK ("funds_status" IN ('NOT_CREDITED', 'AVAILABLE', 'PARTIALLY_FROZEN', 'FROZEN', 'RETURN_PENDING', 'RETURNED')),
  "risk_status" text NOT NULL DEFAULT 'PASS' CHECK ("risk_status" IN ('PASS', 'REVIEW', 'BLOCK')),
  "risk_reasons_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "ledger_transaction_id" text REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "external_received_at" timestamptz,
  "credited_at" timestamptz,
  "returned_at" timestamptz,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_deposit_orders_user_time"
  ON "deposit_orders" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_deposit_orders_branch_status_time"
  ON "deposit_orders" ("branch_id", "order_status", "created_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_deposit_orders_provider_order_unique"
  ON "deposit_orders" ("provider", "provider_order_id")
  WHERE "provider_order_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_deposit_orders_provider_event_unique"
  ON "deposit_orders" ("provider", "provider_event_id")
  WHERE "provider_event_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_deposit_orders_tx_unique"
  ON "deposit_orders" ("network", "tx_id", COALESCE("tx_index", 0))
  WHERE "tx_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "deposit_risk_flags" (
  "id" text PRIMARY KEY,
  "deposit_order_id" text NOT NULL REFERENCES "deposit_orders"("id") ON DELETE CASCADE,
  "flag_type" text NOT NULL,
  "severity" text NOT NULL CHECK ("severity" IN ('low', 'medium', 'high', 'block')),
  "details_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deposit_action_requests" (
  "id" text PRIMARY KEY,
  "deposit_order_id" text NOT NULL REFERENCES "deposit_orders"("id") ON DELETE RESTRICT,
  "action" text NOT NULL CHECK ("action" IN (
    'APPROVE_CREDIT', 'REJECT_DEPOSIT', 'MANUAL_RECORD',
    'FREEZE_FUNDS', 'UNFREEZE_FUNDS', 'REQUEST_RETURN', 'CONFIRM_RETURN'
  )),
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
  "requested_by_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "reason" text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "deposit_action_decisions" (
  "id" text PRIMARY KEY,
  "request_id" text NOT NULL REFERENCES "deposit_action_requests"("id") ON DELETE CASCADE,
  "reviewer_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL CHECK ("decision" IN ('approve', 'reject')),
  "note" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("request_id", "reviewer_user_id")
);

CREATE TABLE IF NOT EXISTS "reconciliation_runs" (
  "id" text PRIMARY KEY,
  "scope" text NOT NULL CHECK ("scope" IN ('incremental', 'daily_full', 'manual')),
  "status" text NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
  "filters_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "reconciliation_discrepancies" (
  "id" text PRIMARY KEY,
  "run_id" text NOT NULL REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE,
  "discrepancy_type" text NOT NULL CHECK ("discrepancy_type" IN (
    'EXTERNAL_WITHOUT_ORDER', 'ORDER_WITHOUT_EXTERNAL_PAYMENT',
    'CREDITED_WITHOUT_LEDGER', 'LEDGER_WITHOUT_BALANCE',
    'BALANCE_MISMATCH', 'AMOUNT_MISMATCH',
    'DUPLICATE_EXTERNAL_REFERENCE', 'REFUND_MISMATCH'
  )),
  "severity" text NOT NULL CHECK ("severity" IN ('info', 'warning', 'critical')),
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "details_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'reviewing', 'resolved', 'ignored')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deposit_exports" (
  "id" text PRIMARY KEY,
  "requested_by_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "application_id" text NOT NULL DEFAULT 'operations' REFERENCES "applications"("id") ON DELETE RESTRICT,
  "filters_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "row_count" integer,
  "status" text NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'expired')),
  "storage_key" text,
  "expires_at" timestamptz,
  "downloaded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "notification_provider_configs" (
  "id" text PRIMARY KEY,
  "provider" text NOT NULL,
  "channel" text NOT NULL CHECK ("channel" IN ('email', 'telegram', 'whatsapp', 'in_app')),
  "status" text NOT NULL DEFAULT 'disabled' CHECK ("status" IN ('active', 'disabled', 'sandbox')),
  "sender_domain" text,
  "settings_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "encrypted_secret_ref" text,
  "last_test_at" timestamptz,
  "last_error_code" text,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("provider", "channel")
);

INSERT INTO "applications" ("id", "name", "domain", "local_port")
VALUES
  ('client', 'Riverton Capital 客户端', 'agentnovas.com', 3000),
  ('operations', 'Riverton Capital 运营端', 'zht.agentnovas.com', 3001),
  ('maintenance', 'Riverton Capital 运维端', 'xm.agentnovas.com', 3002)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "domain" = EXCLUDED."domain",
  "local_port" = EXCLUDED."local_port",
  "updated_at" = now();

INSERT INTO "permission_definitions" ("key", "application_id", "label", "sensitive")
VALUES
  ('client.strategies.create', 'client', '创建策略', false),
  ('client.strategies.publish', 'client', '提交策略广场', false),
  ('client.wallet.view', 'client', '查看钱包', false),
  ('client.deposit.create', 'client', '创建充值订单', false),
  ('ops.customers.view', 'operations', '查看客户', false),
  ('ops.customers.manage', 'operations', '管理客户', true),
  ('ops.deposits.view', 'operations', '查看充值订单', false),
  ('ops.deposits.export', 'operations', '导出充值订单', true),
  ('ops.deposits.pii_reveal', 'operations', '查看完整敏感字段', true),
  ('ops.deposits.action_request', 'operations', '发起充值人工操作', true),
  ('ops.deposits.action_approve', 'operations', '审批充值人工操作', true),
  ('ops.ledger.view', 'operations', '查看账务', false),
  ('ops.reconciliation.run', 'operations', '执行对账', true),
  ('ops.support.manage', 'operations', '处理客服工单', false),
  ('ops.roles.manage', 'operations', '管理运营角色', true),
  ('ops.roles.assign', 'operations', '分配运营角色', true),
  ('ops.roles.approve_sensitive', 'operations', '审批敏感权限', true),
  ('maint.llm_profiles.manage', 'maintenance', '管理模型 Profile', true),
  ('maint.agent_bindings.manage', 'maintenance', '管理 Agent 绑定', true),
  ('maint.payment_integrations.manage', 'maintenance', '管理支付集成', true),
  ('maint.email_integrations.manage', 'maintenance', '管理邮件集成', true),
  ('maint.feature_flags.manage', 'maintenance', '管理功能开关', true),
  ('maint.system_health.view', 'maintenance', '查看系统健康', false),
  ('maint.emergency_pause.execute', 'maintenance', '执行紧急暂停', true),
  ('maint.audit.view', 'maintenance', '查看审计', false),
  ('maint.roles.manage', 'maintenance', '管理运维角色', true),
  ('maint.roles.approve_sensitive', 'maintenance', '审批运维敏感权限', true)
ON CONFLICT ("key") DO UPDATE SET
  "label" = EXCLUDED."label",
  "sensitive" = EXCLUDED."sensitive",
  "updated_at" = now();

INSERT INTO "notification_provider_configs" ("id", "provider", "channel", "status", "sender_domain")
VALUES
  ('resend-email', 'resend', 'email', 'disabled', 'mail.agentnovas.com'),
  ('telegram-bot', 'telegram', 'telegram', 'disabled', NULL),
  ('whatsapp-cloud', 'meta_whatsapp_cloud', 'whatsapp', 'disabled', NULL)
ON CONFLICT ("provider", "channel") DO NOTHING;
