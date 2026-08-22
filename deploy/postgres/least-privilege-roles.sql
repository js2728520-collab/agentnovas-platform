\set ON_ERROR_STOP on

-- Invoke only after migrations, with an explicit database name:
-- psql --set=agentnovas_database=agentnovas --file=deploy/postgres/least-privilege-roles.sql
\if :{?agentnovas_database}
\else
  \echo 'agentnovas_database is required'
  \quit
\endif

SELECT current_database() = :'agentnovas_database' AS agentnovas_database_matches \gset
\if :agentnovas_database_matches
\else
  \echo 'Refusing to configure roles in a different database'
  \quit
\endif

SELECT current_database() ~ '^agentnovas(_[a-z0-9]+)*$' AS agentnovas_database_is_controlled \gset
\if :agentnovas_database_is_controlled
\else
  \echo 'Refusing to configure roles outside a controlled AgentNovas database'
  \quit
\endif

BEGIN;

DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'agentnovas_migrator',
    'agentnovas_client_auth',
    'agentnovas_client_web',
    'agentnovas_ops_web',
    'agentnovas_maint_web',
    'agentnovas_payment_webhook',
    'agentnovas_notification_worker',
    'agentnovas_demo_execution_worker',
    'agentnovas_runtime_worker'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', role_name);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', role_name);
    END IF;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY['agentnovas_payment_worker','agentnovas_research_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', role_name);
    ELSE
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', role_name);
    END IF;
  END LOOP;
END
$roles$;

ALTER ROLE agentnovas_migrator SET search_path=pg_catalog,public;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE :"agentnovas_database" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM
  agentnovas_client_web,
  agentnovas_client_auth,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker,
  agentnovas_payment_worker,
  agentnovas_research_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_payment_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM agentnovas_payment_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_research_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM agentnovas_research_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM
  agentnovas_client_web,
  agentnovas_client_auth,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM
  agentnovas_client_web,
  agentnovas_client_auth,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker;

GRANT CONNECT ON DATABASE :"agentnovas_database" TO
  agentnovas_migrator,
  agentnovas_client_auth,
  agentnovas_client_web,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker;
GRANT USAGE ON SCHEMA public TO
  agentnovas_client_auth,
  agentnovas_client_web,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker;
GRANT CREATE, USAGE ON SCHEMA public TO agentnovas_migrator;

-- The first controlled bootstrap adopts only objects in this explicitly bound
-- database's public schema. It does not reassign cluster- or database-wide objects.
DO $ownership$
DECLARE
  object record;
  statement text;
BEGIN
  FOR object IN
    SELECT class.relkind, class.relname
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname='public'
      AND class.relkind IN ('r','p','S','v','m','f')
      AND (
        class.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_depend AS dependency
          WHERE dependency.classid='pg_class'::regclass
            AND dependency.objid=class.oid
            AND dependency.deptype IN ('a','i')
        )
      )
  LOOP
    statement := CASE object.relkind
      WHEN 'S' THEN 'ALTER SEQUENCE'
      WHEN 'v' THEN 'ALTER VIEW'
      WHEN 'm' THEN 'ALTER MATERIALIZED VIEW'
      WHEN 'f' THEN 'ALTER FOREIGN TABLE'
      ELSE 'ALTER TABLE'
    END;
    EXECUTE format('%s public.%I OWNER TO agentnovas_migrator', statement, object.relname);
  END LOOP;

  FOR object IN
    SELECT procedure.oid::regprocedure AS identity
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
    WHERE namespace.nspname='public'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO agentnovas_migrator', object.identity);
  END LOOP;
END
$ownership$;

-- Converge identity ACLs even on upgraded clusters that still contain a
-- legacy/third-party role. RLS also uses an explicit role allowlist, but stale
-- table grants must not remain as a second path to credentials or PII.
DO $identity_acl_convergence$
DECLARE role_row record;
BEGIN
  FOR role_row IN
    SELECT rolname FROM pg_roles
     WHERE rolname NOT IN (
       'agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web',
       'agentnovas_notification_worker'
     )
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.users,public.sessions,public.auth_tokens,public.user_mfa_totp_credentials,public.user_mfa_recovery_codes,public.invitations FROM %I',
      role_row.rolname
    );
  END LOOP;
END
$identity_acl_convergence$;

-- A restored explicit EXECUTE grant must not turn an unknown/legacy database
-- role into an identity API. Rebuild the gateway ACL from zero, pin its path,
-- then add only the two exact Client roles below.
DO $identity_gateway_acl_convergence$
DECLARE gateway record;
DECLARE role_row record;
BEGIN
  FOR gateway IN
    SELECT procedure.oid::regprocedure AS identity
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname='public' AND procedure.proname LIKE 'client\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, public', gateway.identity);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', gateway.identity);
    FOR role_row IN SELECT rolname FROM pg_roles WHERE rolname<>'agentnovas_migrator' LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', gateway.identity, role_row.rolname);
    END LOOP;
  END LOOP;
END
$identity_gateway_acl_convergence$;

-- Client can read only Client/shared product data. Secret-bearing provider and
-- model-revision tables are intentionally absent; the Demo account view is safe.
GRANT SELECT ON
  applications, organizations, permission_definitions, roles, role_permissions,
  user_role_assignments, rbac_revocation_tombstones, system_role_identities,
  auth_rate_limit_buckets,
  commercial_plan_versions, commercial_legal_document_versions,
  commercial_disclosure_bundles, commercial_legal_acceptances,
  commercial_membership_orders, commercial_membership_order_decisions,
  commercial_payment_evidence, commercial_idempotency_records, memberships,
  membership_access_events,
  membership_entitlement_events, ai_credit_accounts, ai_credit_ledger_entries,
  ai_credit_reservations, client_ai_inference_requests, ai_usage_daily,
  performance_fee_statements,
  performance_fee_decisions, performance_fee_receivables,
  performance_fee_high_water_marks, high_water_marks, notification_channels,
  notification_preferences, notification_deliveries, ai_conversations, ai_messages,
  market_candles, market_data_snapshots, market_watchlist, community_strategies,
  strategy_versions, strategy_subscriptions, strategy_favorites, strategy_deployments,
  strategy_runtime_cycles, strategy_runtime_events, strategy_agent_events,
  official_paper_portfolios, official_paper_positions, official_paper_order_intents,
  official_paper_fill_receipts, official_paper_ledger_entries,
  platform_demo_order_intents, platform_demo_execution_receipts,
  platform_demo_fill_receipts, wallet_balances, wallet_balance_versions,
  ledger_accounts, ledger_transactions, ledger_postings, trades, customer_attributions,
  deposit_orders
  TO agentnovas_client_web;
GRANT SELECT ON platform_demo_accounts_safe TO agentnovas_client_web;
GRANT SELECT ON client_payment_provider_configs_safe TO agentnovas_client_web;
GRANT SELECT ON client_ai_runtime_model_bindings TO agentnovas_client_web;
GRANT INSERT, UPDATE ON
  commercial_legal_acceptances,
  commercial_membership_orders, memberships, membership_access_events,
  membership_entitlement_events, ai_credit_accounts, ai_credit_ledger_entries,
  ai_credit_reservations, client_ai_inference_requests, ai_usage_daily,
  notification_channels,
  notification_preferences, notification_deliveries, ai_conversations, ai_messages,
  market_watchlist, strategy_subscriptions, strategy_favorites, strategy_deployments,
  official_paper_portfolios, customer_attributions
  TO agentnovas_client_web;
GRANT INSERT (
  id,platform_order_no,user_id,branch_id,currency,network,expected_amount,usdt_value,
  channel,provider,provider_config_id,deposit_address,required_confirmations,
  order_status,funds_status,risk_status,risk_reasons_json,metadata_json,
  idempotency_key,request_id
) ON deposit_orders TO agentnovas_client_web;
GRANT INSERT, UPDATE ON auth_rate_limit_buckets, commercial_idempotency_records,
  authorization_audit_events, audit_logs TO agentnovas_client_web;
GRANT DELETE ON auth_rate_limit_buckets TO agentnovas_client_web;

GRANT EXECUTE ON FUNCTION
  public.client_registration_attribution(text,text),
  public.client_session_identity(text,timestamptz),
  public.client_touch_session(text,timestamptz,timestamptz),
  public.client_complete_login(text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text),
  public.client_registration_conflicts(text,text),
  public.client_registration_invitation(text),
  public.client_insert_invited_customer(text,text,text,text,text,text),
  public.client_claim_registration_invitation(text,text,text,timestamptz),
  public.client_profile_conflicts(text,text,text,text),
  public.client_update_profile(text,text,text,text,text,text,text,text,text,timestamptz),
  public.client_change_password(text,text,text,timestamptz),
  public.client_list_sessions(text,timestamptz),
  public.client_revoke_session(text,text,timestamptz),
  public.client_revoke_current_session(text,timestamptz),
  public.client_mfa_start(text,text,timestamptz),
  public.client_mfa_credential(text,text),
  public.client_mfa_accept_totp(text,bigint,timestamptz),
  public.client_mfa_consume_recovery(text,text,timestamptz),
  public.client_mfa_replace_recovery(text,jsonb,timestamptz),
  public.client_mfa_complete_enrollment(text,bigint,timestamptz,jsonb,timestamptz),
  public.client_mfa_mark_session_verified(text,text,timestamptz,timestamptz),
  public.client_mfa_recovery_status(text),
  public.client_consume_password_reset(text,text,timestamptz),
  public.client_verify_email(text,timestamptz)
TO agentnovas_client_web;

-- Password verification happens in application memory. Keep its exact
-- identifier projection on a separate non-inheriting role so the shared Web
-- role cannot chain password_hash lookup into session creation.
GRANT EXECUTE ON FUNCTION
  public.client_login_identity(text,text,text),
  public.client_self_password_identity(text,timestamptz),
  public.client_queue_password_reset(text,text,text,timestamptz,text,text,timestamptz)
TO agentnovas_client_auth;

-- Operations receives commercial/customer/control-plane tables, but no provider,
-- exchange, model-key, or Maintenance configuration tables.
GRANT SELECT ON
  applications, organizations, permission_definitions, role_templates,
  role_template_versions, roles, role_permissions, user_role_assignments,
  rbac_revocation_tombstones, system_role_identities, users, sessions, auth_tokens,
  auth_rate_limit_buckets, invitations, user_mfa_totp_credentials, user_mfa_recovery_codes,
  access_change_requests, access_change_decisions, approval_requests,
  approval_decisions, authorization_audit_events, audit_logs, customer_profiles,
  customer_attributions, customer_attribution_change_requests,
  customer_attribution_change_decisions, customer_handover_notes, target_follow_ups,
  commercial_plan_versions, commercial_legal_document_versions,
  commercial_disclosure_bundles, commercial_legal_acceptances,
  commercial_membership_orders, commercial_membership_order_decisions,
  commercial_payment_evidence, commercial_idempotency_records, memberships,
  membership_access_events,
  membership_entitlement_events, ai_credit_accounts, ai_credit_ledger_entries,
  ai_credit_reservations, ai_credit_adjustment_requests,
  ai_credit_adjustment_decisions, performance_fee_statements,
  performance_fee_decisions, performance_fee_receivables,
  performance_fee_high_water_marks, high_water_marks, deposit_orders, deposit_provider_events,
  deposit_risk_flags, deposit_action_requests, deposit_action_decisions,
  deposit_exports, ledger_accounts, ledger_transactions, ledger_postings,
  wallet_balances, wallet_balance_versions, payout_profiles, revenue_events,
  revenue_allocations, settlements, collection_cases, reconciliation_runs,
  reconciliation_discrepancies, monthly_team_targets, notification_channels,
  notification_preferences, notification_deliveries, strategy_subscriptions,
  official_paper_portfolios, official_paper_positions, official_paper_order_intents,
  official_paper_fill_receipts, official_paper_ledger_entries, trades
  TO agentnovas_ops_web;
GRANT SELECT ON commercial_closed_paper_pnl TO agentnovas_ops_web;
GRANT INSERT, UPDATE ON
  users, sessions, auth_tokens, invitations, user_mfa_totp_credentials,
  user_mfa_recovery_codes, access_change_requests, access_change_decisions,
  approval_requests, approval_decisions, authorization_audit_events, audit_logs,
  customer_profiles, customer_attributions, customer_attribution_change_requests,
  customer_attribution_change_decisions, customer_handover_notes, target_follow_ups,
  commercial_membership_orders, commercial_membership_order_decisions,
  commercial_payment_evidence, memberships, membership_access_events,
  membership_entitlement_events, ai_credit_accounts, ai_credit_ledger_entries,
  ai_credit_adjustment_requests, ai_credit_adjustment_decisions,
  performance_fee_statements, performance_fee_decisions,
  performance_fee_receivables, performance_fee_high_water_marks, high_water_marks,
  deposit_orders, deposit_action_requests, deposit_action_decisions, deposit_exports,
  ledger_accounts, ledger_transactions, ledger_postings, wallet_balances,
  wallet_balance_versions, payout_profiles, revenue_events, revenue_allocations,
  settlements, collection_cases, reconciliation_runs,
  reconciliation_discrepancies, monthly_team_targets, notification_deliveries,
  roles, role_permissions, user_role_assignments
  TO agentnovas_ops_web;
GRANT INSERT, UPDATE ON auth_rate_limit_buckets, commercial_idempotency_records
  TO agentnovas_ops_web;
GRANT DELETE ON sessions, auth_tokens, auth_rate_limit_buckets,
  user_mfa_recovery_codes TO agentnovas_ops_web;

-- Maintenance receives technical control-plane tables and shared identity/RBAC,
-- but not customer wallets, ledger, commercial payment evidence, or trading P&L.
GRANT SELECT ON
  applications, organizations, permission_definitions, role_templates,
  role_template_versions, roles, role_permissions, user_role_assignments,
  rbac_revocation_tombstones, system_role_identities, users, sessions, auth_tokens,
  auth_rate_limit_buckets, invitations, user_mfa_totp_credentials, user_mfa_recovery_codes,
  access_change_requests, access_change_decisions, authorization_audit_events,
  audit_logs, llm_configurations, llm_profiles, llm_profile_revisions,
  agent_role_bindings, runtime_explanation_bindings, notification_provider_configs,
  notification_email_suppressions, notification_deliveries, resend_webhook_events,
  payment_provider_configs, platform_settings, platform_follow_policies,
  platform_demo_accounts, platform_demo_admin_commands, platform_demo_card_controls,
  platform_demo_control_audit, platform_demo_order_intents,
  platform_demo_execution_receipts, platform_demo_fill_receipts, worker_instances,
  trading_emergency_stops, commercial_legal_document_versions,
  commercial_disclosure_bundles, commercial_disclosure_publish_requests,
  maintenance_idempotency_records, release_versions, release_verifications,
  release_deployments
  TO agentnovas_maint_web;
GRANT SELECT ON platform_demo_accounts_safe TO agentnovas_maint_web;
GRANT INSERT, UPDATE ON
  users, sessions, auth_tokens, user_mfa_totp_credentials, user_mfa_recovery_codes,
  access_change_requests, access_change_decisions, authorization_audit_events,
  audit_logs, llm_configurations, llm_profiles, llm_profile_revisions,
  agent_role_bindings, runtime_explanation_bindings, notification_provider_configs,
  notification_email_suppressions, notification_deliveries, resend_webhook_events,
  payment_provider_configs, platform_settings, platform_follow_policies,
  platform_demo_accounts, platform_demo_admin_commands, platform_demo_card_controls,
  platform_demo_control_audit, platform_demo_order_intents,
  platform_demo_execution_receipts, platform_demo_fill_receipts, worker_instances,
  trading_emergency_stops, commercial_legal_document_versions,
  commercial_disclosure_bundles, commercial_disclosure_publish_requests,
  maintenance_idempotency_records, roles, role_permissions, user_role_assignments
  TO agentnovas_maint_web;
GRANT INSERT, UPDATE ON auth_rate_limit_buckets TO agentnovas_maint_web;
GRANT INSERT ON release_versions, release_verifications, release_deployments
  TO agentnovas_maint_web;
GRANT DELETE ON sessions, auth_tokens, auth_rate_limit_buckets,
  user_mfa_recovery_codes TO agentnovas_maint_web;

-- Provider callbacks use a dedicated role that cannot read users, wallets,
-- ledger postings, sessions, RBAC, or unrelated integration credentials.
GRANT SELECT ON payment_webhook_provider_configs_safe TO agentnovas_payment_webhook;
GRANT SELECT (
  id,provider_config_id,user_id,network,order_status,tx_id,deposit_address,
  ledger_transaction_id,required_confirmations
) ON deposit_orders TO agentnovas_payment_webhook;
GRANT SELECT (outcome,provider,provider_event_id,nonce_sha256)
  ON deposit_provider_events TO agentnovas_payment_webhook;
GRANT UPDATE (
  actual_amount,usdt_value,tx_id,provider_event_id,confirmations,order_status,
  risk_status,risk_reasons_json,external_received_at,updated_at
) ON deposit_orders TO agentnovas_payment_webhook;
GRANT INSERT (
  id,provider,provider_event_id,provider_config_id,deposit_order_id,event_type,outcome,
  payload_sha256,nonce_sha256,provider_timestamp_ms,tx_id,deposit_address,amount,
  status_code,error_code,request_id
) ON deposit_provider_events TO agentnovas_payment_webhook;
-- Emergency control needs customer scope plus Paper access-state transitions, but
-- Maintenance must not receive table-wide access to positions, orders, or P&L.
GRANT SELECT (customer_id, branch_id, status)
  ON customer_attributions TO agentnovas_maint_web;
GRANT SELECT (id, customer_id, access_status)
  ON official_paper_portfolios TO agentnovas_maint_web;
GRANT UPDATE (access_status, updated_at)
  ON official_paper_portfolios TO agentnovas_maint_web;
GRANT SELECT (portfolio_id, status, quantity)
  ON official_paper_positions TO agentnovas_maint_web;
GRANT SELECT (portfolio_id, action, status)
  ON official_paper_order_intents TO agentnovas_maint_web;
GRANT UPDATE (status, rejection_code)
  ON official_paper_order_intents TO agentnovas_maint_web;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO
  agentnovas_client_web,
  agentnovas_ops_web,
  agentnovas_maint_web;

GRANT SELECT ON notification_provider_configs, notification_email_suppressions, users TO agentnovas_notification_worker;
GRANT SELECT, UPDATE ON memberships, official_paper_portfolios TO agentnovas_notification_worker;
GRANT SELECT ON official_paper_positions TO agentnovas_notification_worker;
GRANT SELECT, INSERT ON membership_access_events TO agentnovas_notification_worker;
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO agentnovas_notification_worker;
GRANT INSERT ON audit_logs TO agentnovas_notification_worker;
GRANT SELECT, INSERT, UPDATE ON worker_instances TO agentnovas_notification_worker;

GRANT SELECT, UPDATE ON platform_demo_accounts, platform_demo_card_controls TO agentnovas_demo_execution_worker;
GRANT SELECT, INSERT, UPDATE ON platform_demo_order_intents, platform_demo_execution_receipts, platform_demo_fill_receipts TO agentnovas_demo_execution_worker;
GRANT SELECT, INSERT, UPDATE ON worker_instances TO agentnovas_demo_execution_worker;

GRANT SELECT ON memberships, strategy_versions, official_paper_portfolios,
  llm_profiles, llm_profile_revisions, runtime_explanation_bindings, market_data_snapshots
  TO agentnovas_runtime_worker;
GRANT SELECT, INSERT, UPDATE ON strategy_deployments, strategy_runtime_cycles,
  strategy_runtime_events, strategy_runtime_explanation_jobs, official_paper_order_intents,
  official_paper_positions, official_paper_fill_receipts, official_paper_ledger_entries,
  worker_instances, market_data_snapshots
  TO agentnovas_runtime_worker;
GRANT UPDATE ON official_paper_portfolios TO agentnovas_runtime_worker;
GRANT SELECT (id,provider,enabled,kill_switch_enabled,last_verified_at,last_verification_status)
  ON platform_demo_accounts TO agentnovas_runtime_worker;
GRANT SELECT ON platform_demo_card_controls TO agentnovas_runtime_worker;
GRANT SELECT, INSERT, UPDATE ON platform_demo_order_intents TO agentnovas_runtime_worker;

-- No ALTER DEFAULT PRIVILEGES are granted to application roles. Re-run this
-- database-bound template after forward migrations so new tables remain closed.

COMMIT;
