\set ON_ERROR_STOP on

-- Invoke only after migrations, with an explicit database name:
-- psql --set=agentnovas_database=agentnovas --file=deploy/postgres/least-privilege-roles.sql
-- 三处拒绝都必须以非零退出码结束。
--
-- 原来用的是 \quit，psql 以 0 退出（这个版本还会忽略 \quit 的参数）——于是
-- 「脚本跑成功了」和「脚本什么都没做」在调用方看来完全一样。部署脚本据此判断成功，
-- 实际一条 GRANT 都没执行，故障要等到某个进程角色第一次写库时才以 42501 冒出来。
--
-- 改成抛 SQL 异常：文件开头的 ON_ERROR_STOP on 会让 psql 以非零码退出。
\if :{?agentnovas_database}
\else
  \echo 'agentnovas_database is required'
  DO $refuse$ BEGIN RAISE EXCEPTION 'agentnovas_database is required'; END $refuse$;
\endif

SELECT current_database() = :'agentnovas_database' AS agentnovas_database_matches \gset
\if :agentnovas_database_matches
\else
  \echo 'Refusing to configure roles in a different database'
  DO $refuse$ BEGIN RAISE EXCEPTION 'Refusing to configure roles in a different database'; END $refuse$;
\endif

SELECT current_database() ~ '^agentnovas(_[a-z0-9]+)*$' AS agentnovas_database_is_controlled \gset
\if :agentnovas_database_is_controlled
\else
  \echo 'Refusing to configure roles outside a controlled AgentNovas database'
  DO $refuse$ BEGIN RAISE EXCEPTION 'Refusing to configure roles outside a controlled AgentNovas database'; END $refuse$;
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
    'agentnovas_configuration_activation_worker',
    'agentnovas_demo_execution_worker',
    'agentnovas_runtime_worker',
    'agentnovas_ai_secret_broker',
    'agentnovas_ai_gateway',
    'agentnovas_execution_service',
    'agentnovas_release_worker',
    'agentnovas_release_control',
    'agentnovas_release_identity_verifier',
    'agentnovas_release_ingress',
    'agentnovas_release_auditor',
    'agentnovas_release_target_gateway'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', role_name);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', role_name);
    END IF;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY[
    'agentnovas_payment_worker',
    'agentnovas_research_worker'
  ] LOOP
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
  agentnovas_configuration_activation_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker,
  agentnovas_ai_secret_broker,
  agentnovas_ai_gateway,
  agentnovas_payment_worker,
  agentnovas_research_worker,
  agentnovas_release_worker,
  agentnovas_release_control,
  agentnovas_release_identity_verifier,
  agentnovas_release_ingress,
  agentnovas_release_auditor,
  agentnovas_release_target_gateway;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_payment_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM agentnovas_payment_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_research_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM agentnovas_research_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM
  agentnovas_release_worker,
  agentnovas_release_control,
  agentnovas_release_identity_verifier,
  agentnovas_release_ingress,
  agentnovas_release_auditor,
  agentnovas_release_target_gateway;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM
  agentnovas_release_worker,
  agentnovas_release_control,
  agentnovas_release_identity_verifier,
  agentnovas_release_ingress,
  agentnovas_release_auditor,
  agentnovas_release_target_gateway;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM
  agentnovas_client_web,
  agentnovas_client_auth,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_configuration_activation_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker,
  agentnovas_ai_secret_broker,
  agentnovas_ai_gateway,
  agentnovas_release_worker,
  agentnovas_release_control,
  agentnovas_release_identity_verifier,
  agentnovas_release_ingress,
  agentnovas_release_auditor,
  agentnovas_release_target_gateway;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM
  agentnovas_client_web,
  agentnovas_client_auth,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_configuration_activation_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker,
  agentnovas_ai_secret_broker,
  agentnovas_ai_gateway,
  agentnovas_release_worker,
  agentnovas_release_control,
  agentnovas_release_identity_verifier,
  agentnovas_release_ingress,
  agentnovas_release_auditor,
  agentnovas_release_target_gateway;

GRANT CONNECT ON DATABASE :"agentnovas_database" TO
  agentnovas_migrator,
  agentnovas_client_auth,
  agentnovas_client_web,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_configuration_activation_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker,
  agentnovas_ai_secret_broker,
  agentnovas_ai_gateway,
  agentnovas_release_worker,
  agentnovas_release_control,
  agentnovas_release_identity_verifier,
  agentnovas_release_ingress,
  agentnovas_release_auditor,
  agentnovas_release_target_gateway;
GRANT USAGE ON SCHEMA public TO
  agentnovas_client_auth,
  agentnovas_client_web,
  agentnovas_ops_web,
  agentnovas_maint_web,
  agentnovas_payment_webhook,
  agentnovas_notification_worker,
  agentnovas_configuration_activation_worker,
  agentnovas_demo_execution_worker,
  agentnovas_runtime_worker,
  agentnovas_ai_secret_broker,
  agentnovas_ai_gateway,
  agentnovas_release_worker,
  agentnovas_release_control,
  agentnovas_release_identity_verifier,
  agentnovas_release_ingress,
  agentnovas_release_auditor,
  agentnovas_release_target_gateway;
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

-- ALTER OWNER does not reconstruct an explicit ACL that was already written by
-- earlier migrations. On a fresh database, tables such as users already have
-- Web-role grants, so reassigning their owner can otherwise leave the migrator
-- named as owner but unable to SELECT/INSERT its own table. Restore only the
-- owner-control role here; runtime roles remain governed by the exact grants
-- below and by FORCE RLS.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO agentnovas_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO agentnovas_migrator;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO agentnovas_migrator;

-- This trigger reads the token-bearing internal link table while guarding
-- Maintenance/Operations writes to roles and role_permissions. Keep the read
-- behind the migrator-owned SECURITY DEFINER function; never grant the Web
-- roles direct SELECT on internal_registration_links.
ALTER FUNCTION public.protect_internal_registration_link_role()
  SET search_path TO pg_catalog, public;
REVOKE ALL ON FUNCTION public.protect_internal_registration_link_role() FROM PUBLIC;

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

-- 内部权限注册链接只属于 Operations。即使从旧备份恢复了 Maintenance 或遗留角色
-- 的 ACL，也在这里收敛掉，避免 token 摘要和使用事实跨 audience 暴露。
DO $internal_registration_link_acl_convergence$
DECLARE role_row record;
BEGIN
  FOR role_row IN
    SELECT rolname FROM pg_roles
     WHERE rolname NOT IN ('agentnovas_migrator','agentnovas_ops_web')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.internal_registration_links,public.internal_registration_link_uses FROM %I',
      role_row.rolname
    );
  END LOOP;
END
$internal_registration_link_acl_convergence$;

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
  market_candles, market_data_snapshots, community_strategies,
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
  strategy_subscriptions, strategy_favorites, strategy_deployments,
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
  public.client_complete_login_v3(text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text,text,text),
  public.client_registration_conflicts(text,text),
  public.client_registration_invitation(text),
  public.client_insert_invited_customer(text,text,text,text,text,text),
  public.client_claim_registration_invitation(text,text,text,timestamptz),
  -- 可复用邀请链接的使用计数。收进函数而不是给 invitations 开写权限——
  -- 那张表存着全部邀请码，公网进程不该碰得到。
  public.client_record_reusable_invitation_use(text,timestamptz),
  public.client_profile_conflicts(text,text,text,text),
  public.client_update_profile(text,text,text,text,text,text,text,text,text,timestamptz),
  public.client_change_password(text,text,text,timestamptz),
  public.client_list_sessions(text,timestamptz),
  public.client_revoke_session(text,text,timestamptz),
  public.client_revoke_current_session(text,timestamptz),
  public.client_revoke_all_sessions(text,timestamptz),
  public.client_mfa_start(text,text,timestamptz),
  public.client_mfa_credential(text,text),
  public.client_mfa_accept_totp(text,bigint,timestamptz),
  public.client_mfa_consume_recovery(text,text,timestamptz),
  public.client_mfa_replace_recovery(text,jsonb,timestamptz),
  public.client_mfa_complete_enrollment(text,bigint,timestamptz,jsonb,timestamptz),
  public.client_mfa_mark_session_verified(text,text,timestamptz,timestamptz),
  public.client_mfa_recovery_status(text),
  public.client_queue_registration_email_verification(text,text,text,timestamptz,text,text,timestamptz),
  public.client_consume_password_reset(text,text,timestamptz),
  public.client_verify_email(text,timestamptz)
TO agentnovas_client_web;

-- Client can resolve one active, non-secret feature flag by exact key. It has
-- no SELECT privilege on the versioned configuration control-plane tables.
GRANT EXECUTE ON FUNCTION
  public.configuration_client_active_feature_flag(text)
TO agentnovas_client_web;

-- Password verification happens in application memory. Keep its exact
-- identifier projection on a separate non-inheriting role so the shared Web
-- role cannot chain password_hash lookup into session creation.
GRANT EXECUTE ON FUNCTION
  public.client_login_identity(text,text,text),
  public.client_self_password_identity(text,timestamptz),
  public.client_queue_email_verification_by_email(text,text,text,timestamptz,text,text,timestamptz),
  public.client_queue_password_reset(text,text,text,timestamptz,text,text,timestamptz)
TO agentnovas_client_auth;

-- Operations receives commercial/customer/control-plane tables, but no provider,
-- exchange credential columns, model-key, or Maintenance configuration tables.
GRANT SELECT ON
  applications, organizations, permission_definitions, role_templates,
  role_template_versions, roles, role_permissions, user_role_assignments,
  rbac_revocation_tombstones, system_role_identities, users, sessions, auth_tokens,
  auth_rate_limit_buckets, invitations, internal_registration_links,
  internal_registration_link_uses, user_mfa_totp_credentials, user_mfa_recovery_codes,
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
  users, sessions, auth_tokens, invitations, internal_registration_links,
  user_mfa_totp_credentials,
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
GRANT INSERT ON organizations, internal_registration_link_uses
  TO agentnovas_ops_web;
GRANT DELETE ON sessions, auth_tokens, auth_rate_limit_buckets,
  user_mfa_recovery_codes TO agentnovas_ops_web;
-- Customer detail may show account identity and readiness, never credential or
-- withdrawal authority material. Keep this column-scoped instead of granting the table.
GRANT SELECT (
  id, customer_id, exchange, label, environment, status,
  can_read, can_trade, last_checked_at, created_at
) ON exchange_accounts TO agentnovas_ops_web;

-- Maintenance receives technical control-plane tables and shared identity/RBAC,
-- but not customer wallets, ledger, commercial payment evidence, or trading P&L.
GRANT SELECT ON
  applications, organizations, permission_definitions, role_templates,
  role_template_versions, roles, role_permissions, user_role_assignments,
  rbac_revocation_tombstones, system_role_identities, users, sessions, auth_tokens,
  auth_rate_limit_buckets, invitations, user_mfa_totp_credentials, user_mfa_recovery_codes,
  access_change_requests, access_change_decisions, authorization_audit_events,
  audit_logs, notification_provider_configs,
  notification_email_suppressions, notification_deliveries, resend_webhook_events,
  payment_provider_configs, platform_settings, platform_follow_policies,
  platform_demo_accounts, platform_demo_admin_commands, platform_demo_card_controls,
  platform_demo_control_audit, platform_demo_order_intents,
  platform_demo_execution_receipts, platform_demo_fill_receipts, worker_instances,
  trading_emergency_stops, commercial_legal_document_versions,
  commercial_disclosure_bundles, commercial_disclosure_publish_requests,
  maintenance_idempotency_records, release_versions, release_verifications,
  release_deployments, configuration_versions, configuration_test_results,
  configuration_approvals, configuration_schedules, configuration_activations
  TO agentnovas_maint_web;
GRANT SELECT ON platform_demo_accounts_safe TO agentnovas_maint_web;
GRANT SELECT ON maintenance_ai_usage_events_safe TO agentnovas_maint_web;
GRANT SELECT ON maintenance_ai_control_plane_snapshot_safe,maintenance_ai_connections_safe,
  maintenance_ai_deployments_safe,maintenance_ai_probe_receipts_safe,maintenance_ai_budgets_safe,
  maintenance_ai_budget_alerts_safe,maintenance_ai_usage_events_v2_safe,
  maintenance_ai_deployment_revisions_safe,maintenance_ai_secret_broker_key_safe
  TO agentnovas_maint_web;
GRANT SELECT ON maintenance_strategy_work_records_safe TO agentnovas_maint_web;
GRANT INSERT, UPDATE ON
  users, sessions, auth_tokens, user_mfa_totp_credentials, user_mfa_recovery_codes,
  access_change_requests, access_change_decisions, authorization_audit_events,
  audit_logs, notification_provider_configs,
  notification_email_suppressions, notification_deliveries, resend_webhook_events,
  payment_provider_configs, platform_settings, platform_follow_policies,
  platform_demo_accounts, platform_demo_admin_commands, platform_demo_card_controls,
  platform_demo_control_audit, platform_demo_order_intents,
  platform_demo_execution_receipts, platform_demo_fill_receipts, worker_instances,
  trading_emergency_stops, commercial_legal_document_versions,
  commercial_disclosure_bundles, commercial_disclosure_publish_requests,
  maintenance_idempotency_records, roles, role_permissions, user_role_assignments
  TO agentnovas_maint_web;
GRANT EXECUTE ON FUNCTION
  public.ai_sync_legacy_profile(text),
  public.ai_sync_legacy_binding(text,text),
  public.ai_save_connection_deployment(text,text,text,text,text,text,text,text,integer,integer,boolean,boolean,text,text,text),
  public.ai_save_connection_deployment_with_rate_card(text,text,text,text,text,text,text,text,integer,integer,boolean,boolean,text,text,text,text,text,text,text,text),
  public.ai_update_binding_policy(text,text,text[],boolean,text,text,text),
  public.ai_upsert_budget_policy(text,text,text,text,text,text,boolean,text,text,text),
  public.ai_request_probe(text,text,text,text,text),
  public.ai_rollback_deployment(text,text,text,text,text,text,text),
  public.ai_enqueue_secret_command(text,text,text,text,text,text,text,text,text,text,text,text,text)
  TO agentnovas_maint_web;
GRANT SELECT ON client_ai_control_plane_bindings_safe,maintenance_ai_control_plane_snapshot_safe
  TO agentnovas_client_web;
GRANT EXECUTE ON FUNCTION public.ai_settle_invocation_credits(text,text)
  TO agentnovas_client_web;
GRANT INSERT, UPDATE ON auth_rate_limit_buckets TO agentnovas_maint_web;
GRANT INSERT ON release_versions, release_verifications, release_deployments
  TO agentnovas_maint_web;
GRANT INSERT ON configuration_versions, configuration_test_results,
  configuration_approvals, configuration_schedules, configuration_activations
  TO agentnovas_maint_web;
GRANT USAGE, SELECT ON SEQUENCE configuration_test_results_sequence_no_seq,
  configuration_activations_sequence_no_seq TO agentnovas_maint_web;
GRANT DELETE ON sessions, auth_tokens, auth_rate_limit_buckets,
  user_mfa_recovery_codes TO agentnovas_maint_web;
-- System overview exposes aggregate readiness and queue ages only. These
-- column grants intentionally omit customer ids, amounts, strategy payloads,
-- provider data, and migration timestamps.
GRANT SELECT (name, checksum, commit_sha)
  ON _agentnovas_migrations TO agentnovas_maint_web;
GRANT SELECT (status, next_attempt_at, created_at)
  ON strategy_research_runs TO agentnovas_maint_web;
GRANT SELECT (status, created_at)
  ON commercial_membership_orders TO agentnovas_maint_web;
GRANT SELECT (status, created_at)
  ON performance_fee_statements TO agentnovas_maint_web;
GRANT SELECT (status, price_currency)
  ON commercial_plan_versions TO agentnovas_maint_web;

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

-- Per-user appearance and locale are available to every Web audience only
-- through session-token-bound gateways. No Web role receives direct access to
-- another user's or another audience's preference row.
GRANT EXECUTE ON FUNCTION
  public.user_app_preference_read(text,timestamptz),
  public.user_app_preference_upsert(text,text,text,text,timestamptz)
  TO agentnovas_client_web,agentnovas_ops_web,agentnovas_maint_web;

GRANT SELECT ON notification_provider_configs, notification_email_suppressions, users TO agentnovas_notification_worker;
GRANT SELECT, UPDATE ON memberships, official_paper_portfolios TO agentnovas_notification_worker;
GRANT SELECT ON official_paper_positions TO agentnovas_notification_worker;
GRANT SELECT, INSERT ON membership_access_events TO agentnovas_notification_worker;
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO agentnovas_notification_worker;
GRANT INSERT ON audit_logs TO agentnovas_notification_worker;
GRANT SELECT, INSERT, UPDATE ON worker_instances TO agentnovas_notification_worker;

-- AI secret custody and invocation run in two non-Web processes. The Broker
-- never receives legacy profile ciphertext; the Gateway never receives the
-- Broker private key or command envelopes.
GRANT SELECT ON ai_secret_broker_keys TO agentnovas_ai_secret_broker;
GRANT SELECT, UPDATE ON ai_secret_commands TO agentnovas_ai_secret_broker;
GRANT SELECT, INSERT ON ai_secret_receipts TO agentnovas_ai_secret_broker;
GRANT SELECT ON ai_connection_revisions TO agentnovas_ai_secret_broker;
GRANT UPDATE(secret_ref,secret_fingerprint,config_fingerprint) ON ai_connection_revisions TO agentnovas_ai_secret_broker;
GRANT SELECT ON ai_deployment_revisions TO agentnovas_ai_secret_broker;
GRANT UPDATE(config_fingerprint) ON ai_deployment_revisions TO agentnovas_ai_secret_broker;
GRANT SELECT,INSERT,UPDATE ON ai_legacy_secret_migration_receipts TO agentnovas_ai_secret_broker;

GRANT SELECT ON ai_control_plane_roles,ai_provider_connections,ai_connection_revisions,
  ai_model_deployments,ai_deployment_revisions,ai_binding_policies,
  ai_binding_policy_revisions,ai_binding_targets,ai_rate_card_revisions,ai_budget_policies
  TO agentnovas_ai_gateway;
GRANT SELECT ON gateway_client_ai_attribution_safe TO agentnovas_ai_gateway;
GRANT SELECT,INSERT,UPDATE ON ai_invocation_receipts TO agentnovas_ai_gateway;
GRANT SELECT,INSERT ON ai_usage_events TO agentnovas_ai_gateway;
GRANT SELECT,UPDATE ON ai_probe_receipts TO agentnovas_ai_gateway;
GRANT EXECUTE ON FUNCTION public.ai_evaluate_budget_alerts(timestamptz) TO agentnovas_ai_gateway;

-- The due activation worker can read only immutable configuration release
-- facts, execute one owner-controlled activation gateway, and report its own
-- heartbeat. It has no direct activation/audit append or sequence capability.
GRANT SELECT ON configuration_versions, configuration_test_results,
  configuration_approvals, configuration_schedules, configuration_activations
  TO agentnovas_configuration_activation_worker;
GRANT SELECT, INSERT, UPDATE ON worker_instances
  TO agentnovas_configuration_activation_worker;
GRANT EXECUTE ON FUNCTION
  public.configuration_activation_worker_activate(text)
  TO agentnovas_configuration_activation_worker;

GRANT SELECT, UPDATE ON platform_demo_accounts, platform_demo_card_controls TO agentnovas_demo_execution_worker;
GRANT SELECT, INSERT, UPDATE ON platform_demo_order_intents, platform_demo_execution_receipts, platform_demo_fill_receipts TO agentnovas_demo_execution_worker;
GRANT SELECT, INSERT, UPDATE ON worker_instances TO agentnovas_demo_execution_worker;

GRANT SELECT ON memberships, strategy_versions, official_paper_portfolios,
  worker_ai_deployment_revisions_safe, market_data_snapshots
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

-- ---------------------------------------------------------------------------
-- 0044–0053 新增对象的授权。
--
-- 这一段此前是空的：全部 54 个迁移里只有 0043 含 GRANT，而授权的唯一真源是本文件。
-- 于是跑完 0044–0053 之后，运营端的熔断开关页与实盘路由页会全线 PostgreSQL 42501，
-- 执行服务连自己的对账表都读不了。
-- 文件末尾那句「新表保持关闭」是刻意的默认，但默认之后必须有人来开。

-- 执行服务：全系统唯一能解密交易所凭证的进程。
--
-- 它读凭证密文，写对账与回执。**不给它任何客户身份表的权限**——它不需要知道
-- 客户是谁，只需要知道这个账户属于那个 customerId（归属校验在 SQL 的 WHERE 里做）。
GRANT SELECT ON exchange_accounts, strategy_deployments, official_paper_portfolios
  TO agentnovas_execution_service;
GRANT SELECT, INSERT, UPDATE ON execution_reconciliations TO agentnovas_execution_service;
-- 回执只增不改：0053 的触发器已禁止 UPDATE/DELETE，这里连 UPDATE 权限都不给，
-- 两层各自独立。
GRANT SELECT, INSERT ON live_execution_receipts TO agentnovas_execution_service;
-- 熔断与实盘授权只读：执行服务查闸门，但无权自行开关。
GRANT SELECT ON execution_kill_switches, execution_live_routing TO agentnovas_execution_service;
GRANT SELECT, UPDATE ON trades TO agentnovas_execution_service;
GRANT INSERT ON audit_logs TO agentnovas_execution_service;
GRANT SELECT, INSERT, UPDATE ON worker_instances TO agentnovas_execution_service;
GRANT SELECT, INSERT ON platform_decisions TO agentnovas_execution_service;

-- 运营端：熔断与实盘路由的操作界面。
--
-- 两张表都不给 DELETE：熔断与授权的历史是事后复盘的依据，
-- 0051/0052 的触发器禁止复活已解除的记录，权限层再挡一次删除。
GRANT SELECT, INSERT, UPDATE ON execution_kill_switches TO agentnovas_ops_web;
GRANT SELECT, INSERT, UPDATE ON execution_live_routing TO agentnovas_ops_web;
GRANT SELECT ON execution_reconciliations, live_execution_receipts TO agentnovas_ops_web;

-- 运维端：审计链尾锚点。登记与校验都在这里，不给删除。
GRANT SELECT, INSERT ON audit_chain_anchors TO agentnovas_maint_web;

-- Runtime Worker：共享决策轮（0046–0048）。
GRANT SELECT, INSERT, UPDATE ON strategy_decision_rounds TO agentnovas_runtime_worker;
-- 实盘部署要读绑定的交易所账户是否可用，但**不读凭证密文**——
-- 列级授权把 encrypted_credential_ref 挡在外面，Worker 拿不到它。
GRANT SELECT (id, customer_id, exchange, environment, status, can_trade, withdrawal_authorized)
  ON exchange_accounts TO agentnovas_runtime_worker;

-- 客户端与运营端读共享决策轮，用于展示七阶段叙述。
GRANT SELECT ON strategy_decision_rounds TO agentnovas_client_web, agentnovas_ops_web;

-- T8.1c gives only the release Worker a LOGIN role so the separately gated
-- process can authenticate. A newly created role still has PASSWORD NULL and
-- the runtime switch remains false; secret provisioning is external to Git.
DO $restricted_cicd_acl_convergence$
DECLARE gateway record;
DECLARE role_row record;
BEGIN
  FOR gateway IN
    SELECT procedure.oid::regprocedure AS identity
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname='public' AND procedure.proname LIKE 'release\_workflow\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, public',gateway.identity);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',gateway.identity);
    FOR role_row IN SELECT rolname FROM pg_roles WHERE rolname<>'agentnovas_migrator' LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',gateway.identity,role_row.rolname);
    END LOOP;
  END LOOP;
  FOR role_row IN SELECT rolname FROM pg_roles WHERE rolname<>'agentnovas_migrator' LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.release_workflow_safe_status FROM %I',role_row.rolname);
  END LOOP;
  REVOKE ALL ON TABLE public.release_workflow_safe_status FROM PUBLIC;
END
$restricted_cicd_acl_convergence$;

GRANT SELECT ON release_workflow_safe_status TO agentnovas_maint_web;
GRANT EXECUTE ON FUNCTION public.release_workflow_read_maintenance_control(integer)
  TO agentnovas_maint_web;
GRANT EXECUTE ON FUNCTION public.release_workflow_issue_human_action_authority(text,text,text,text,text,text,text)
  TO agentnovas_maint_web;
GRANT EXECUTE ON FUNCTION
  public.release_workflow_execute_human_action(text,text,text,text)
  TO agentnovas_release_control;
GRANT EXECUTE ON FUNCTION
  public.release_workflow_record_human_action_assertion(
    text,text,text,text,text,text,text,text,text,bigint,text,text,timestamptz,timestamptz,
    text,text,text,text,text
  ),
  public.release_workflow_resolve_human_action_assertion(text,text,text,text,text,text)
  TO agentnovas_release_identity_verifier;
GRANT EXECUTE ON FUNCTION
  public.release_workflow_recover_expired_dispatch_v2(text),
  public.release_workflow_claim_next_reconciliation_v2(text,text,jsonb),
  public.release_workflow_claim_next_command_v2(text,text,integer,text,text,text,text,text,text,text,text,text,jsonb),
  public.release_workflow_begin_dispatch(text,text,bigint,text),
  public.release_workflow_record_dispatch_unknown(text,text,bigint,text,text),
  public.release_workflow_bind_provider_run(text,text,bigint,text,text,text),
  public.release_workflow_reject_bound_run(text,text,text,bigint,text,text,text),
  public.release_workflow_append_provider_event(text,text,text,bigint,text,text,text,jsonb,timestamptz),
  public.release_workflow_worker_heartbeat(text,text,text,bigint,text,timestamptz)
  TO agentnovas_release_worker;
GRANT EXECUTE ON FUNCTION
  public.release_workflow_append_delivery(text,text,text,text,text,text,integer,text,text,text,text,text,integer)
  TO agentnovas_release_ingress;
GRANT EXECUTE ON FUNCTION
  public.release_workflow_append_run_policy_attestation(text,text,text,text,integer,text,text,text,text,text,text,text,text,text,timestamptz)
  TO agentnovas_release_auditor;
GRANT EXECUTE ON FUNCTION
  public.release_workflow_reserve_workflow_target_request_v4(text,text,text,text,text,text,text,bigint,text,text,text,text,text,text,text),
  public.release_workflow_validate_target_authority_v2(text,bigint,text,bigint,text,text,text),
  public.release_workflow_validate_target_cutover_v2(text,bigint,text,bigint,text,text,text,text,text,text,text,timestamptz),
  public.release_workflow_recover_target_operation_v2(text,text,text,text),
  public.release_workflow_list_recoverable_target_operations_v2(text,text,text,text),
  public.release_workflow_assert_migration_registry(text),
  public.release_workflow_takeover_target_operation(text,text,bigint,bigint,text,text,text),
  public.release_workflow_append_target_receipt(text,text,text,text,jsonb,text,text,text,bigint,bigint,text,text,boolean),
  public.release_workflow_target_request_stop(text,text,text,text,text),
  public.release_workflow_prepare_target_clear_ack_v2(text,text,bigint,text,text,text),
  public.release_workflow_validate_target_stop_cleared_v2(text,text,bigint,text,text),
  public.release_workflow_append_stop_receipt_v2(text,text,text,bigint,text,text,text,text,text,jsonb,text,text,text,text,text,boolean)
  TO agentnovas_release_target_gateway;

-- No ALTER DEFAULT PRIVILEGES are granted to application roles. Re-run this
-- database-bound template after forward migrations so new tables remain closed.

COMMIT;
