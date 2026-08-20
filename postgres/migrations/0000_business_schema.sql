-- PostgreSQL business schema used by the self-hosted Linux deployment.
-- Keep legacy booleans as integers and timestamps as ISO text so the existing Drizzle schema remains wire-compatible.

CREATE TABLE IF NOT EXISTS "_agentnovas_migrations" (
  "name" text PRIMARY KEY,
  "applied_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "ai_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "title" text NOT NULL DEFAULT '新对话',
  "purpose" text NOT NULL DEFAULT 'consultation',
  "status" text NOT NULL DEFAULT 'active',
  "last_message_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "ai_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "user_id" text NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "generation_mode" text,
  "provider_name" text,
  "model" text,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "ai_usage_daily" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "usage_date" text NOT NULL,
  "request_count" integer NOT NULL DEFAULT 0,
  "input_chars" integer NOT NULL DEFAULT 0,
  "output_chars" integer NOT NULL DEFAULT 0,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "approval_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL,
  "reviewer_id" text NOT NULL,
  "decision" text NOT NULL,
  "note" text NOT NULL DEFAULT '',
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "branch_id" text,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "payload_json" text NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'pending',
  "requested_by" text NOT NULL,
  "requested_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "completed_at" text
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_user_id" text,
  "action" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "before_json" text,
  "after_json" text,
  "ip_address" text,
  "user_agent" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "auth_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "purpose" text NOT NULL,
  "expires_at" text NOT NULL,
  "used_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "collection_cases" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "settlement_id" text NOT NULL,
  "due_at" text NOT NULL,
  "grace_ends_at" text NOT NULL,
  "reminders_sent" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'payment_period',
  "new_entries_allowed" integer NOT NULL DEFAULT 1,
  "paid_confirmed_by" text,
  "paid_confirmed_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "community_strategies" (
  "id" text PRIMARY KEY NOT NULL,
  "author_user_id" text NOT NULL,
  "name" text NOT NULL,
  "summary" text NOT NULL DEFAULT '',
  "market" text NOT NULL DEFAULT 'crypto',
  "symbols_json" text NOT NULL DEFAULT '[]',
  "risk_level" text NOT NULL DEFAULT 'medium',
  "status" text NOT NULL DEFAULT 'draft',
  "conversation_json" text NOT NULL DEFAULT '[]',
  "specification_json" text NOT NULL DEFAULT '{}',
  "version" integer NOT NULL DEFAULT 1,
  "submitted_at" text,
  "approved_at" text,
  "published_at" text,
  "rejection_reason" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "featured_rank" integer,
  "ranking_score" double precision NOT NULL DEFAULT 0,
  "last_followed_at" text,
  "auto_delisted_at" text,
  "publication_mode" text NOT NULL DEFAULT 'marketplace',
  "validation_label" text NOT NULL DEFAULT 'UNVERIFIED',
  "research_run_id" text,
  "research_candidate_id" text
);

CREATE TABLE IF NOT EXISTS "customer_attributions" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "source" text NOT NULL,
  "status" text NOT NULL,
  "branch_id" text,
  "manager_id" text,
  "supervisor_id" text,
  "employee_id" text,
  "effective_at" text,
  "ended_at" text,
  "reason" text NOT NULL DEFAULT '',
  "approval_id" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "customer_handover_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "author_user_id" text NOT NULL,
  "content" text NOT NULL,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "customer_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "display_name" text NOT NULL DEFAULT '',
  "contact_note" text NOT NULL DEFAULT '',
  "archived_at" text,
  "archived_by" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "exchange_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "exchange" text NOT NULL,
  "label" text NOT NULL,
  "environment" text NOT NULL DEFAULT 'demo',
  "encrypted_credential_ref" text NOT NULL,
  "can_read" integer NOT NULL DEFAULT 0,
  "can_trade" integer NOT NULL DEFAULT 0,
  "withdrawal_authorized" integer NOT NULL DEFAULT 0,
  "withdrawal_credential_ref" text,
  "status" text NOT NULL DEFAULT 'pending',
  "last_checked_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "high_water_marks" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "exchange_account_id" text NOT NULL,
  "realized_net_pnl_usdt" double precision NOT NULL DEFAULT 0,
  "charged_profit_usdt" double precision NOT NULL DEFAULT 0,
  "high_water_mark_usdt" double precision NOT NULL DEFAULT 0,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "code_hash" text NOT NULL,
  "kind" text NOT NULL,
  "issuer_user_id" text NOT NULL,
  "owner_employee_id" text,
  "organization_id" text,
  "status" text NOT NULL DEFAULT 'active',
  "used_by_user_id" text,
  "used_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "llm_configurations" (
  "id" text PRIMARY KEY NOT NULL,
  "scope" text NOT NULL,
  "owner_user_id" text,
  "provider_name" text NOT NULL DEFAULT 'OpenAI Compatible',
  "base_url" text NOT NULL,
  "model" text NOT NULL,
  "encrypted_api_key" text NOT NULL DEFAULT '',
  "masked_api_key" text NOT NULL DEFAULT '',
  "enabled" integer NOT NULL DEFAULT 1,
  "updated_by_user_id" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "market_watchlist" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "symbol" text NOT NULL,
  "category" text NOT NULL,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "memberships" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "plan_code" text NOT NULL,
  "status" text NOT NULL,
  "starts_at" text,
  "expires_at" text,
  "grace_ends_at" text,
  "max_exchange_accounts" integer NOT NULL DEFAULT 1,
  "max_active_strategies" integer NOT NULL DEFAULT 1,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "monthly_team_targets" (
  "id" text PRIMARY KEY NOT NULL,
  "month" text NOT NULL,
  "branch_id" text NOT NULL,
  "assigned_by_user_id" text NOT NULL,
  "assignee_user_id" text NOT NULL,
  "new_customers_target" integer NOT NULL DEFAULT 0,
  "monthly_cards_target" integer NOT NULL DEFAULT 0,
  "quarterly_cards_target" integer NOT NULL DEFAULT 0,
  "annual_cards_target" integer NOT NULL DEFAULT 0,
  "note" text NOT NULL DEFAULT '',
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "notification_channels" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "channel" text NOT NULL,
  "destination" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "verification_token_hash" text,
  "verified_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "channel" text NOT NULL,
  "category" text NOT NULL,
  "template_key" text NOT NULL,
  "payload_json" text NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "provider_message_id" text,
  "last_error" text,
  "scheduled_at" text NOT NULL,
  "sent_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "dedupe_key" text,
  "read_at" text,
  "lease_owner" text,
  "lease_expires_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "channel" text NOT NULL,
  "category" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'instant',
  "quiet_start" text,
  "quiet_end" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "organizations" (
  "id" text PRIMARY KEY NOT NULL,
  "parent_id" text,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "payout_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text,
  "owner_organization_id" text,
  "network" text NOT NULL,
  "address" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_review',
  "approval_id" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "platform_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "exchange_account_id" text NOT NULL,
  "strategy_version" text NOT NULL,
  "agent_task_id" text,
  "risk_approval_id" text,
  "symbol" text NOT NULL,
  "status" text NOT NULL,
  "evidence_json" text NOT NULL DEFAULT '{}',
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "strategy_code" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "platform_follow_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "allow_follow_without_withdrawal" integer NOT NULL DEFAULT 0,
  "updated_by_user_id" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "platform_strategy_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_code" text NOT NULL,
  "customer_id" text NOT NULL,
  "exchange_account_id" text NOT NULL,
  "capital_pct" double precision NOT NULL DEFAULT 3,
  "stop_loss_pct" double precision NOT NULL DEFAULT 3,
  "status" text NOT NULL DEFAULT 'active',
  "risk_consent_at" text,
  "last_risk_check_at" text,
  "risk_check_json" text NOT NULL DEFAULT '{}',
  "started_at" text,
  "ended_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "revenue_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "revenue_event_id" text NOT NULL,
  "beneficiary_type" text NOT NULL,
  "beneficiary_id" text,
  "rate" double precision NOT NULL,
  "amount_usdt" double precision NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "settlement_batch_id" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "revenue_events" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "type" text NOT NULL,
  "source_id" text NOT NULL,
  "amount_usdt" double precision NOT NULL,
  "confirmed_at" text NOT NULL,
  "attribution_id" text,
  "attribution_status" text NOT NULL,
  "rule_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'confirmed',
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" text NOT NULL,
  "revoked_at" text,
  "ip_address" text,
  "user_agent" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "settlements" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "period_start" text NOT NULL,
  "period_end" text NOT NULL,
  "beneficiary_id" text,
  "amount_usdt" double precision NOT NULL,
  "network" text,
  "status" text NOT NULL DEFAULT 'draft',
  "approval_id" text,
  "tx_hash" text,
  "adjustment_note" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "strategy_author_earnings" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "author_user_id" text NOT NULL,
  "revenue_event_id" text NOT NULL,
  "fee_rate" double precision NOT NULL,
  "gross_performance_fee_usdt" double precision NOT NULL,
  "platform_fee_usdt" double precision NOT NULL,
  "author_amount_usdt" double precision NOT NULL,
  "collection_confirmed_at" text NOT NULL,
  "period_month" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "settlement_id" text,
  "paid_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "strategy_change_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "author_user_id" text NOT NULL,
  "action" text NOT NULL,
  "reason" text NOT NULL,
  "proposed_changes_json" text NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'notice_period',
  "requested_at" text NOT NULL,
  "notice_ends_at" text NOT NULL,
  "completed_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "strategy_favorites" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "strategy_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "risk_consent_at" text,
  "started_at" text,
  "ended_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "exchange_account_id" text,
  "capital_pct" double precision NOT NULL DEFAULT 5,
  "stop_loss_pct" double precision NOT NULL DEFAULT 10,
  "execution_mode" text NOT NULL DEFAULT 'proportional',
  "last_risk_check_at" text,
  "risk_check_json" text NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS "strategy_validations" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "source" text NOT NULL DEFAULT 'author_submitted',
  "period_start" text,
  "period_end" text,
  "sample_size" integer,
  "net_return_pct" double precision,
  "max_drawdown_pct" double precision,
  "win_rate_pct" double precision,
  "metrics_json" text NOT NULL DEFAULT '{}',
  "evidence_ref" text,
  "reviewed_by" text,
  "completed_at" text,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "strategy_version" integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS "strategy_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "strategy_id" text NOT NULL,
  "version" integer NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "summary" text NOT NULL DEFAULT '',
  "specification_json" text NOT NULL,
  "conversation_id" text,
  "source" text NOT NULL DEFAULT 'manual',
  "created_by_user_id" text NOT NULL,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "restored_from_version" integer
);

CREATE TABLE IF NOT EXISTS "target_follow_ups" (
  "id" text PRIMARY KEY NOT NULL,
  "month" text NOT NULL,
  "branch_id" text NOT NULL,
  "subject_user_id" text NOT NULL,
  "alert_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'resolved',
  "note" text NOT NULL DEFAULT '',
  "handled_by_user_id" text NOT NULL,
  "handled_at" text NOT NULL,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS "trades" (
  "id" text PRIMARY KEY NOT NULL,
  "exchange_account_id" text NOT NULL,
  "customer_id" text NOT NULL,
  "decision_id" text,
  "exchange_order_id" text NOT NULL,
  "symbol" text NOT NULL,
  "side" text NOT NULL,
  "origin" text NOT NULL,
  "status" text NOT NULL,
  "opened_at" text,
  "closed_at" text,
  "quantity" double precision NOT NULL,
  "entry_value_usdt" double precision NOT NULL DEFAULT 0,
  "exit_value_usdt" double precision NOT NULL DEFAULT 0,
  "fees_usdt" double precision NOT NULL DEFAULT 0,
  "funding_usdt" double precision NOT NULL DEFAULT 0,
  "realized_net_pnl_usdt" double precision NOT NULL DEFAULT 0,
  "locked_fx_rate" double precision,
  "fee_rate" double precision,
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "strategy_code" text,
  "community_strategy_id" text,
  "close_exchange_order_id" text,
  "execution_venue" text NOT NULL DEFAULT 'internal_demo'
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "email_verified_at" text,
  "role" text NOT NULL,
  "organization_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "locale" text NOT NULL DEFAULT 'zh-CN',
  "timezone" text NOT NULL DEFAULT 'Asia/Shanghai',
  "created_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "reports_to_user_id" text,
  "username" text,
  "nickname" text NOT NULL DEFAULT '',
  "avatar_url" text NOT NULL DEFAULT '',
  "phone" text,
  "date_of_birth" text,
  "gender" text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS "idx_ai_conversations_user_status_time" ON "ai_conversations" ("user_id", "status", "last_message_at");
CREATE INDEX IF NOT EXISTS "idx_ai_messages_conversation_time" ON "ai_messages" ("conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_ai_messages_user_role_time" ON "ai_messages" ("user_id", "role", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ai_usage_user_date_unique" ON "ai_usage_daily" ("user_id", "usage_date");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_approval_reviewer_unique" ON "approval_decisions" ("request_id","reviewer_id");
CREATE INDEX IF NOT EXISTS "idx_approvals_branch_status" ON "approval_requests" ("branch_id","status");
CREATE INDEX IF NOT EXISTS "idx_approvals_subject" ON "approval_requests" ("subject_type","subject_id");
CREATE INDEX IF NOT EXISTS "idx_audit_actor_time" ON "audit_logs" ("actor_user_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_audit_subject_time" ON "audit_logs" ("subject_type","subject_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_tokens_hash_unique" ON "auth_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "idx_auth_tokens_user_purpose" ON "auth_tokens" ("user_id","purpose");
CREATE INDEX IF NOT EXISTS "idx_collection_due_status" ON "collection_cases" ("status","due_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_collection_settlement_unique" ON "collection_cases" ("settlement_id");
CREATE INDEX IF NOT EXISTS "idx_community_strategies_author" ON "community_strategies" ("author_user_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_community_strategies_featured_unique" ON "community_strategies" ("featured_rank");
CREATE INDEX IF NOT EXISTS "idx_community_strategies_ranking" ON "community_strategies" ("status","ranking_score");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_community_strategies_research_candidate_unique" ON "community_strategies" ("research_candidate_id");
CREATE INDEX IF NOT EXISTS "idx_community_strategies_status" ON "community_strategies" ("status","published_at");
CREATE INDEX IF NOT EXISTS "idx_attribution_branch_status" ON "customer_attributions" ("branch_id","status");
CREATE INDEX IF NOT EXISTS "idx_attribution_customer_effective" ON "customer_attributions" ("customer_id","effective_at");
CREATE INDEX IF NOT EXISTS "idx_customer_handover_notes_customer_time" ON "customer_handover_notes" ("customer_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_customer_profiles_customer_unique" ON "customer_profiles" ("customer_id");
CREATE INDEX IF NOT EXISTS "idx_exchange_accounts_customer" ON "exchange_accounts" ("customer_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_hwm_account_unique" ON "high_water_marks" ("customer_id","exchange_account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invitations_code_unique" ON "invitations" ("code_hash");
CREATE INDEX IF NOT EXISTS "idx_invitations_owner_status" ON "invitations" ("owner_employee_id","status");
CREATE INDEX IF NOT EXISTS "idx_llm_config_scope_enabled" ON "llm_configurations" ("scope","enabled");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_llm_config_scope_owner_unique" ON "llm_configurations" ("scope","owner_user_id");
CREATE INDEX IF NOT EXISTS "idx_market_watchlist_customer_created" ON "market_watchlist" ("customer_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_market_watchlist_customer_symbol_unique" ON "market_watchlist" ("customer_id", "symbol");
CREATE INDEX IF NOT EXISTS "idx_memberships_customer_status" ON "memberships" ("customer_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_monthly_targets_assignee_month" ON "monthly_team_targets" ("assignee_user_id","month");
CREATE INDEX IF NOT EXISTS "idx_monthly_targets_assigner_month" ON "monthly_team_targets" ("assigned_by_user_id","month");
CREATE INDEX IF NOT EXISTS "idx_monthly_targets_branch_month" ON "monthly_team_targets" ("branch_id","month");
CREATE INDEX IF NOT EXISTS "idx_notification_channel_status" ON "notification_channels" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notification_channel_unique" ON "notification_channels" ("user_id","channel");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_dedupe_unique" ON "notification_deliveries" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "idx_notifications_status_schedule" ON "notification_deliveries" ("status","scheduled_at");
CREATE INDEX IF NOT EXISTS "idx_notifications_email_claim" ON "notification_deliveries" ("status","scheduled_at","lease_expires_at","attempts") WHERE "channel" = 'email';
CREATE INDEX IF NOT EXISTS "idx_notifications_lease_owner" ON "notification_deliveries" ("lease_owner","lease_expires_at") WHERE "lease_owner" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notification_pref_unique" ON "notification_preferences" ("user_id","channel","category");
CREATE INDEX IF NOT EXISTS "idx_organizations_parent" ON "organizations" ("parent_id");
CREATE INDEX IF NOT EXISTS "idx_payout_profile_owner" ON "payout_profiles" ("owner_user_id","owner_organization_id","status");
CREATE INDEX IF NOT EXISTS "idx_decisions_customer_status" ON "platform_decisions" ("customer_id","status");
CREATE INDEX IF NOT EXISTS "idx_decisions_strategy_status" ON "platform_decisions" ("strategy_code","status");
CREATE INDEX IF NOT EXISTS "idx_platform_follow_policies_updated" ON "platform_follow_policies" ("updated_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_strategy_subscription_unique" ON "platform_strategy_subscriptions" ("strategy_code", "customer_id");
CREATE INDEX IF NOT EXISTS "idx_platform_strategy_subscriptions_customer" ON "platform_strategy_subscriptions" ("customer_id", "status");
CREATE INDEX IF NOT EXISTS "idx_platform_strategy_subscriptions_status" ON "platform_strategy_subscriptions" ("status", "strategy_code");
CREATE INDEX IF NOT EXISTS "idx_allocations_beneficiary_status" ON "revenue_allocations" ("beneficiary_type","beneficiary_id","status");
CREATE INDEX IF NOT EXISTS "idx_allocations_revenue" ON "revenue_allocations" ("revenue_event_id");
CREATE INDEX IF NOT EXISTS "idx_revenue_confirmed" ON "revenue_events" ("confirmed_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_revenue_source_unique" ON "revenue_events" ("type","source_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sessions_token_unique" ON "sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "idx_sessions_user_expiry" ON "sessions" ("user_id","expires_at");
CREATE INDEX IF NOT EXISTS "idx_settlements_period_status" ON "settlements" ("kind","period_end","status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_strategy_author_earning_revenue" ON "strategy_author_earnings" ("revenue_event_id");
CREATE INDEX IF NOT EXISTS "idx_strategy_author_earnings_author_period" ON "strategy_author_earnings" ("author_user_id","period_month","status");
CREATE INDEX IF NOT EXISTS "idx_strategy_change_status_due" ON "strategy_change_requests" ("status","notice_ends_at");
CREATE INDEX IF NOT EXISTS "idx_strategy_change_strategy" ON "strategy_change_requests" ("strategy_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_strategy_favorite_unique" ON "strategy_favorites" ("strategy_id","customer_id");
CREATE INDEX IF NOT EXISTS "idx_strategy_favorites_customer" ON "strategy_favorites" ("customer_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_strategy_subscription_unique" ON "strategy_subscriptions" ("strategy_id","customer_id");
CREATE INDEX IF NOT EXISTS "idx_strategy_subscriptions_customer" ON "strategy_subscriptions" ("customer_id","status");
CREATE INDEX IF NOT EXISTS "idx_strategy_validations_strategy_kind" ON "strategy_validations" ("strategy_id","kind","status");
CREATE INDEX IF NOT EXISTS "idx_strategy_versions_conversation" ON "strategy_versions" ("conversation_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_strategy_versions_strategy_version_unique" ON "strategy_versions" ("strategy_id", "version");
CREATE INDEX IF NOT EXISTS "idx_target_followup_branch_month" ON "target_follow_ups" ("branch_id","month","status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_target_followup_subject_month_type" ON "target_follow_ups" ("subject_user_id","month","alert_type");
CREATE INDEX IF NOT EXISTS "idx_trades_community_strategy_closed" ON "trades" ("community_strategy_id","closed_at");
CREATE INDEX IF NOT EXISTS "idx_trades_customer_closed" ON "trades" ("customer_id","closed_at");
CREATE INDEX IF NOT EXISTS "idx_trades_decision" ON "trades" ("decision_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_trades_exchange_order_unique" ON "trades" ("exchange_account_id","exchange_order_id");
CREATE INDEX IF NOT EXISTS "idx_trades_strategy_closed" ON "trades" ("strategy_code","closed_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email_unique" ON "users" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_nickname_ci_unique" ON "users" (lower("nickname")) WHERE "nickname" <> '';
CREATE INDEX IF NOT EXISTS "idx_users_org_role" ON "users" ("organization_id","role");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_phone_unique" ON "users" ("phone");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_username_ci_unique" ON "users" (lower("username")) WHERE "username" IS NOT NULL AND "username" <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_username_unique" ON "users" ("username");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_conversations'::regclass AND conname = 'fk_ai_conversations_user_id_0') THEN
    ALTER TABLE "ai_conversations" ADD CONSTRAINT "fk_ai_conversations_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_messages'::regclass AND conname = 'fk_ai_messages_user_id_0') THEN
    ALTER TABLE "ai_messages" ADD CONSTRAINT "fk_ai_messages_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_messages'::regclass AND conname = 'fk_ai_messages_conversation_id_1') THEN
    ALTER TABLE "ai_messages" ADD CONSTRAINT "fk_ai_messages_conversation_id_1" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_usage_daily'::regclass AND conname = 'fk_ai_usage_daily_user_id_0') THEN
    ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "fk_ai_usage_daily_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'approval_decisions'::regclass AND conname = 'fk_approval_decisions_reviewer_id_0') THEN
    ALTER TABLE "approval_decisions" ADD CONSTRAINT "fk_approval_decisions_reviewer_id_0" FOREIGN KEY ("reviewer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'approval_decisions'::regclass AND conname = 'fk_approval_decisions_request_id_1') THEN
    ALTER TABLE "approval_decisions" ADD CONSTRAINT "fk_approval_decisions_request_id_1" FOREIGN KEY ("request_id") REFERENCES "approval_requests" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'approval_requests'::regclass AND conname = 'fk_approval_requests_requested_by_0') THEN
    ALTER TABLE "approval_requests" ADD CONSTRAINT "fk_approval_requests_requested_by_0" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'approval_requests'::regclass AND conname = 'fk_approval_requests_branch_id_1') THEN
    ALTER TABLE "approval_requests" ADD CONSTRAINT "fk_approval_requests_branch_id_1" FOREIGN KEY ("branch_id") REFERENCES "organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'audit_logs'::regclass AND conname = 'fk_audit_logs_actor_user_id_0') THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "fk_audit_logs_actor_user_id_0" FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'auth_tokens'::regclass AND conname = 'fk_auth_tokens_user_id_0') THEN
    ALTER TABLE "auth_tokens" ADD CONSTRAINT "fk_auth_tokens_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'collection_cases'::regclass AND conname = 'fk_collection_cases_paid_confirmed_by_0') THEN
    ALTER TABLE "collection_cases" ADD CONSTRAINT "fk_collection_cases_paid_confirmed_by_0" FOREIGN KEY ("paid_confirmed_by") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'collection_cases'::regclass AND conname = 'fk_collection_cases_settlement_id_1') THEN
    ALTER TABLE "collection_cases" ADD CONSTRAINT "fk_collection_cases_settlement_id_1" FOREIGN KEY ("settlement_id") REFERENCES "settlements" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'collection_cases'::regclass AND conname = 'fk_collection_cases_customer_id_2') THEN
    ALTER TABLE "collection_cases" ADD CONSTRAINT "fk_collection_cases_customer_id_2" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'community_strategies'::regclass AND conname = 'fk_community_strategies_author_user_id_0') THEN
    ALTER TABLE "community_strategies" ADD CONSTRAINT "fk_community_strategies_author_user_id_0" FOREIGN KEY ("author_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_attributions'::regclass AND conname = 'fk_customer_attributions_employee_id_0') THEN
    ALTER TABLE "customer_attributions" ADD CONSTRAINT "fk_customer_attributions_employee_id_0" FOREIGN KEY ("employee_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_attributions'::regclass AND conname = 'fk_customer_attributions_supervisor_id_1') THEN
    ALTER TABLE "customer_attributions" ADD CONSTRAINT "fk_customer_attributions_supervisor_id_1" FOREIGN KEY ("supervisor_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_attributions'::regclass AND conname = 'fk_customer_attributions_manager_id_2') THEN
    ALTER TABLE "customer_attributions" ADD CONSTRAINT "fk_customer_attributions_manager_id_2" FOREIGN KEY ("manager_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_attributions'::regclass AND conname = 'fk_customer_attributions_branch_id_3') THEN
    ALTER TABLE "customer_attributions" ADD CONSTRAINT "fk_customer_attributions_branch_id_3" FOREIGN KEY ("branch_id") REFERENCES "organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_attributions'::regclass AND conname = 'fk_customer_attributions_customer_id_4') THEN
    ALTER TABLE "customer_attributions" ADD CONSTRAINT "fk_customer_attributions_customer_id_4" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_handover_notes'::regclass AND conname = 'fk_customer_handover_notes_author_user_id_0') THEN
    ALTER TABLE "customer_handover_notes" ADD CONSTRAINT "fk_customer_handover_notes_author_user_id_0" FOREIGN KEY ("author_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_handover_notes'::regclass AND conname = 'fk_customer_handover_notes_customer_id_1') THEN
    ALTER TABLE "customer_handover_notes" ADD CONSTRAINT "fk_customer_handover_notes_customer_id_1" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_profiles'::regclass AND conname = 'fk_customer_profiles_archived_by_0') THEN
    ALTER TABLE "customer_profiles" ADD CONSTRAINT "fk_customer_profiles_archived_by_0" FOREIGN KEY ("archived_by") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'customer_profiles'::regclass AND conname = 'fk_customer_profiles_customer_id_1') THEN
    ALTER TABLE "customer_profiles" ADD CONSTRAINT "fk_customer_profiles_customer_id_1" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'exchange_accounts'::regclass AND conname = 'fk_exchange_accounts_customer_id_0') THEN
    ALTER TABLE "exchange_accounts" ADD CONSTRAINT "fk_exchange_accounts_customer_id_0" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'high_water_marks'::regclass AND conname = 'fk_high_water_marks_exchange_account_id_0') THEN
    ALTER TABLE "high_water_marks" ADD CONSTRAINT "fk_high_water_marks_exchange_account_id_0" FOREIGN KEY ("exchange_account_id") REFERENCES "exchange_accounts" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'high_water_marks'::regclass AND conname = 'fk_high_water_marks_customer_id_1') THEN
    ALTER TABLE "high_water_marks" ADD CONSTRAINT "fk_high_water_marks_customer_id_1" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'invitations'::regclass AND conname = 'fk_invitations_used_by_user_id_0') THEN
    ALTER TABLE "invitations" ADD CONSTRAINT "fk_invitations_used_by_user_id_0" FOREIGN KEY ("used_by_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'invitations'::regclass AND conname = 'fk_invitations_organization_id_1') THEN
    ALTER TABLE "invitations" ADD CONSTRAINT "fk_invitations_organization_id_1" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'invitations'::regclass AND conname = 'fk_invitations_owner_employee_id_2') THEN
    ALTER TABLE "invitations" ADD CONSTRAINT "fk_invitations_owner_employee_id_2" FOREIGN KEY ("owner_employee_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'invitations'::regclass AND conname = 'fk_invitations_issuer_user_id_3') THEN
    ALTER TABLE "invitations" ADD CONSTRAINT "fk_invitations_issuer_user_id_3" FOREIGN KEY ("issuer_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'llm_configurations'::regclass AND conname = 'fk_llm_configurations_updated_by_user_id_0') THEN
    ALTER TABLE "llm_configurations" ADD CONSTRAINT "fk_llm_configurations_updated_by_user_id_0" FOREIGN KEY ("updated_by_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'llm_configurations'::regclass AND conname = 'fk_llm_configurations_owner_user_id_1') THEN
    ALTER TABLE "llm_configurations" ADD CONSTRAINT "fk_llm_configurations_owner_user_id_1" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_watchlist'::regclass AND conname = 'fk_market_watchlist_customer_id_0') THEN
    ALTER TABLE "market_watchlist" ADD CONSTRAINT "fk_market_watchlist_customer_id_0" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'memberships'::regclass AND conname = 'fk_memberships_customer_id_0') THEN
    ALTER TABLE "memberships" ADD CONSTRAINT "fk_memberships_customer_id_0" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'monthly_team_targets'::regclass AND conname = 'fk_monthly_team_targets_assignee_user_id_0') THEN
    ALTER TABLE "monthly_team_targets" ADD CONSTRAINT "fk_monthly_team_targets_assignee_user_id_0" FOREIGN KEY ("assignee_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'monthly_team_targets'::regclass AND conname = 'fk_monthly_team_targets_assigned_by_user_id_1') THEN
    ALTER TABLE "monthly_team_targets" ADD CONSTRAINT "fk_monthly_team_targets_assigned_by_user_id_1" FOREIGN KEY ("assigned_by_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'monthly_team_targets'::regclass AND conname = 'fk_monthly_team_targets_branch_id_2') THEN
    ALTER TABLE "monthly_team_targets" ADD CONSTRAINT "fk_monthly_team_targets_branch_id_2" FOREIGN KEY ("branch_id") REFERENCES "organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'notification_channels'::regclass AND conname = 'fk_notification_channels_user_id_0') THEN
    ALTER TABLE "notification_channels" ADD CONSTRAINT "fk_notification_channels_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'notification_deliveries'::regclass AND conname = 'fk_notification_deliveries_user_id_0') THEN
    ALTER TABLE "notification_deliveries" ADD CONSTRAINT "fk_notification_deliveries_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'notification_preferences'::regclass AND conname = 'fk_notification_preferences_user_id_0') THEN
    ALTER TABLE "notification_preferences" ADD CONSTRAINT "fk_notification_preferences_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'payout_profiles'::regclass AND conname = 'fk_payout_profiles_owner_organization_id_0') THEN
    ALTER TABLE "payout_profiles" ADD CONSTRAINT "fk_payout_profiles_owner_organization_id_0" FOREIGN KEY ("owner_organization_id") REFERENCES "organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'payout_profiles'::regclass AND conname = 'fk_payout_profiles_owner_user_id_1') THEN
    ALTER TABLE "payout_profiles" ADD CONSTRAINT "fk_payout_profiles_owner_user_id_1" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform_decisions'::regclass AND conname = 'fk_platform_decisions_exchange_account_id_0') THEN
    ALTER TABLE "platform_decisions" ADD CONSTRAINT "fk_platform_decisions_exchange_account_id_0" FOREIGN KEY ("exchange_account_id") REFERENCES "exchange_accounts" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform_decisions'::regclass AND conname = 'fk_platform_decisions_customer_id_1') THEN
    ALTER TABLE "platform_decisions" ADD CONSTRAINT "fk_platform_decisions_customer_id_1" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform_follow_policies'::regclass AND conname = 'fk_platform_follow_policies_updated_by_user_id_0') THEN
    ALTER TABLE "platform_follow_policies" ADD CONSTRAINT "fk_platform_follow_policies_updated_by_user_id_0" FOREIGN KEY ("updated_by_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform_strategy_subscriptions'::regclass AND conname = 'fk_platform_strategy_subscriptions_exchange_account_id_0') THEN
    ALTER TABLE "platform_strategy_subscriptions" ADD CONSTRAINT "fk_platform_strategy_subscriptions_exchange_account_id_0" FOREIGN KEY ("exchange_account_id") REFERENCES "exchange_accounts" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'platform_strategy_subscriptions'::regclass AND conname = 'fk_platform_strategy_subscriptions_customer_id_1') THEN
    ALTER TABLE "platform_strategy_subscriptions" ADD CONSTRAINT "fk_platform_strategy_subscriptions_customer_id_1" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'revenue_allocations'::regclass AND conname = 'fk_revenue_allocations_revenue_event_id_0') THEN
    ALTER TABLE "revenue_allocations" ADD CONSTRAINT "fk_revenue_allocations_revenue_event_id_0" FOREIGN KEY ("revenue_event_id") REFERENCES "revenue_events" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'revenue_events'::regclass AND conname = 'fk_revenue_events_customer_id_0') THEN
    ALTER TABLE "revenue_events" ADD CONSTRAINT "fk_revenue_events_customer_id_0" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'sessions'::regclass AND conname = 'fk_sessions_user_id_0') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_user_id_0" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_author_earnings'::regclass AND conname = 'fk_strategy_author_earnings_settlement_id_0') THEN
    ALTER TABLE "strategy_author_earnings" ADD CONSTRAINT "fk_strategy_author_earnings_settlement_id_0" FOREIGN KEY ("settlement_id") REFERENCES "settlements" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_author_earnings'::regclass AND conname = 'fk_strategy_author_earnings_revenue_event_id_1') THEN
    ALTER TABLE "strategy_author_earnings" ADD CONSTRAINT "fk_strategy_author_earnings_revenue_event_id_1" FOREIGN KEY ("revenue_event_id") REFERENCES "revenue_events" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_author_earnings'::regclass AND conname = 'fk_strategy_author_earnings_author_user_id_2') THEN
    ALTER TABLE "strategy_author_earnings" ADD CONSTRAINT "fk_strategy_author_earnings_author_user_id_2" FOREIGN KEY ("author_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_author_earnings'::regclass AND conname = 'fk_strategy_author_earnings_strategy_id_3') THEN
    ALTER TABLE "strategy_author_earnings" ADD CONSTRAINT "fk_strategy_author_earnings_strategy_id_3" FOREIGN KEY ("strategy_id") REFERENCES "community_strategies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_change_requests'::regclass AND conname = 'fk_strategy_change_requests_author_user_id_0') THEN
    ALTER TABLE "strategy_change_requests" ADD CONSTRAINT "fk_strategy_change_requests_author_user_id_0" FOREIGN KEY ("author_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_change_requests'::regclass AND conname = 'fk_strategy_change_requests_strategy_id_1') THEN
    ALTER TABLE "strategy_change_requests" ADD CONSTRAINT "fk_strategy_change_requests_strategy_id_1" FOREIGN KEY ("strategy_id") REFERENCES "community_strategies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_favorites'::regclass AND conname = 'fk_strategy_favorites_customer_id_0') THEN
    ALTER TABLE "strategy_favorites" ADD CONSTRAINT "fk_strategy_favorites_customer_id_0" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_favorites'::regclass AND conname = 'fk_strategy_favorites_strategy_id_1') THEN
    ALTER TABLE "strategy_favorites" ADD CONSTRAINT "fk_strategy_favorites_strategy_id_1" FOREIGN KEY ("strategy_id") REFERENCES "community_strategies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_subscriptions'::regclass AND conname = 'fk_strategy_subscriptions_customer_id_0') THEN
    ALTER TABLE "strategy_subscriptions" ADD CONSTRAINT "fk_strategy_subscriptions_customer_id_0" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_subscriptions'::regclass AND conname = 'fk_strategy_subscriptions_strategy_id_1') THEN
    ALTER TABLE "strategy_subscriptions" ADD CONSTRAINT "fk_strategy_subscriptions_strategy_id_1" FOREIGN KEY ("strategy_id") REFERENCES "community_strategies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_subscriptions'::regclass AND conname = 'fk_strategy_subscriptions_exchange_account_id_2') THEN
    ALTER TABLE "strategy_subscriptions" ADD CONSTRAINT "fk_strategy_subscriptions_exchange_account_id_2" FOREIGN KEY ("exchange_account_id") REFERENCES "exchange_accounts" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_validations'::regclass AND conname = 'fk_strategy_validations_reviewed_by_0') THEN
    ALTER TABLE "strategy_validations" ADD CONSTRAINT "fk_strategy_validations_reviewed_by_0" FOREIGN KEY ("reviewed_by") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_validations'::regclass AND conname = 'fk_strategy_validations_strategy_id_1') THEN
    ALTER TABLE "strategy_validations" ADD CONSTRAINT "fk_strategy_validations_strategy_id_1" FOREIGN KEY ("strategy_id") REFERENCES "community_strategies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_versions'::regclass AND conname = 'fk_strategy_versions_created_by_user_id_0') THEN
    ALTER TABLE "strategy_versions" ADD CONSTRAINT "fk_strategy_versions_created_by_user_id_0" FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_versions'::regclass AND conname = 'fk_strategy_versions_conversation_id_1') THEN
    ALTER TABLE "strategy_versions" ADD CONSTRAINT "fk_strategy_versions_conversation_id_1" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'strategy_versions'::regclass AND conname = 'fk_strategy_versions_strategy_id_2') THEN
    ALTER TABLE "strategy_versions" ADD CONSTRAINT "fk_strategy_versions_strategy_id_2" FOREIGN KEY ("strategy_id") REFERENCES "community_strategies" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'target_follow_ups'::regclass AND conname = 'fk_target_follow_ups_handled_by_user_id_0') THEN
    ALTER TABLE "target_follow_ups" ADD CONSTRAINT "fk_target_follow_ups_handled_by_user_id_0" FOREIGN KEY ("handled_by_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'target_follow_ups'::regclass AND conname = 'fk_target_follow_ups_subject_user_id_1') THEN
    ALTER TABLE "target_follow_ups" ADD CONSTRAINT "fk_target_follow_ups_subject_user_id_1" FOREIGN KEY ("subject_user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'target_follow_ups'::regclass AND conname = 'fk_target_follow_ups_branch_id_2') THEN
    ALTER TABLE "target_follow_ups" ADD CONSTRAINT "fk_target_follow_ups_branch_id_2" FOREIGN KEY ("branch_id") REFERENCES "organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'trades'::regclass AND conname = 'fk_trades_decision_id_0') THEN
    ALTER TABLE "trades" ADD CONSTRAINT "fk_trades_decision_id_0" FOREIGN KEY ("decision_id") REFERENCES "platform_decisions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'trades'::regclass AND conname = 'fk_trades_customer_id_1') THEN
    ALTER TABLE "trades" ADD CONSTRAINT "fk_trades_customer_id_1" FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'trades'::regclass AND conname = 'fk_trades_exchange_account_id_2') THEN
    ALTER TABLE "trades" ADD CONSTRAINT "fk_trades_exchange_account_id_2" FOREIGN KEY ("exchange_account_id") REFERENCES "exchange_accounts" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'fk_users_organization_id_0') THEN
    ALTER TABLE "users" ADD CONSTRAINT "fk_users_organization_id_0" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
