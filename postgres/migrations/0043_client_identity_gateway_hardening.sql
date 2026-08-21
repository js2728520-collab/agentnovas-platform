-- The shared Client Web role is an application principal, not a customer
-- principal. Even if an obsolete ACL is restored accidentally, identity rows
-- remain inaccessible and all customer operations must cross a bounded gateway.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_totp_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_totp_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_recovery_codes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_client_identity_partition ON users;
CREATE POLICY users_client_identity_partition ON users
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web','agentnovas_notification_worker'))
  WITH CHECK (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web','agentnovas_notification_worker'));

DROP POLICY IF EXISTS sessions_client_identity_partition ON sessions;
CREATE POLICY sessions_client_identity_partition ON sessions
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'))
  WITH CHECK (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'));

DROP POLICY IF EXISTS auth_tokens_client_identity_partition ON auth_tokens;
CREATE POLICY auth_tokens_client_identity_partition ON auth_tokens
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'))
  WITH CHECK (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'));

DROP POLICY IF EXISTS user_mfa_totp_credentials_client_identity_partition ON user_mfa_totp_credentials;
CREATE POLICY user_mfa_totp_credentials_client_identity_partition ON user_mfa_totp_credentials
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'))
  WITH CHECK (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'));

DROP POLICY IF EXISTS user_mfa_recovery_codes_client_identity_partition ON user_mfa_recovery_codes;
CREATE POLICY user_mfa_recovery_codes_client_identity_partition ON user_mfa_recovery_codes
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'))
  WITH CHECK (current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'));

-- Migration 0043 must also be safe when application roles have not been
-- created yet. Catalog-driven revocation converges only roles that exist.
DO $identity_table_acl_convergence$
DECLARE
  table_name text;
  table_identity text;
  role_row record;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users','sessions','auth_tokens','user_mfa_totp_credentials',
    'user_mfa_recovery_codes','invitations'
  ] LOOP
    table_identity := format('%I.%I', current_schema(), table_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC', table_identity);
    FOR role_row IN
      SELECT rolname
        FROM pg_roles
       WHERE rolname NOT IN (
         'agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web',
         'agentnovas_notification_worker'
       )
    LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM %I', table_identity, role_row.rolname);
    END LOOP;
  END LOOP;
END
$identity_table_acl_convergence$;

-- SECURITY DEFINER routines have a fixed catalog-first path. Their explicit
-- ACL is reconstructed here when roles already exist, and again by the
-- database-bound least-privilege bootstrap after all migrations.
DO $identity_gateway_acl_convergence$
DECLARE
  routine regprocedure;
  owner_name text;
  role_row record;
  expected_role text;
BEGIN
  FOR routine IN SELECT unnest(ARRAY[
    'client_registration_attribution(text,text)'::regprocedure,
    'client_login_identity(text,text,text)'::regprocedure,
    'client_session_identity(text,timestamp with time zone)'::regprocedure,
    'client_self_password_identity(text,timestamp with time zone)'::regprocedure,
    'client_touch_session(text,timestamp with time zone,timestamp with time zone)'::regprocedure,
    'client_complete_login(text,text,text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)'::regprocedure,
    'client_registration_conflicts(text,text)'::regprocedure,
    'client_registration_invitation(text)'::regprocedure,
    'client_insert_invited_customer(text,text,text,text,text,text)'::regprocedure,
    'client_claim_registration_invitation(text,text,text,timestamp with time zone)'::regprocedure,
    'client_profile_conflicts(text,text,text,text)'::regprocedure,
    'client_update_profile(text,text,text,text,text,text,text,text,text,timestamp with time zone)'::regprocedure,
    'client_change_password(text,text,text,timestamp with time zone)'::regprocedure,
    'client_list_sessions(text,timestamp with time zone)'::regprocedure,
    'client_revoke_session(text,text,timestamp with time zone)'::regprocedure,
    'client_revoke_current_session(text,timestamp with time zone)'::regprocedure,
    'client_mfa_start(text,text,timestamp with time zone)'::regprocedure,
    'client_mfa_credential(text,text)'::regprocedure,
    'client_mfa_accept_totp(text,bigint,timestamp with time zone)'::regprocedure,
    'client_mfa_consume_recovery(text,text,timestamp with time zone)'::regprocedure,
    'client_mfa_replace_recovery(text,jsonb,timestamp with time zone)'::regprocedure,
    'client_mfa_complete_enrollment(text,bigint,timestamp with time zone,jsonb,timestamp with time zone)'::regprocedure,
    'client_mfa_mark_session_verified(text,text,timestamp with time zone,timestamp with time zone)'::regprocedure,
    'client_mfa_recovery_status(text)'::regprocedure,
    'client_queue_password_reset(text,text,text,timestamp with time zone,text,text,timestamp with time zone)'::regprocedure,
    'client_consume_password_reset(text,text,timestamp with time zone)'::regprocedure,
    'client_verify_email(text,timestamp with time zone)'::regprocedure
  ]) LOOP
    SELECT role.rolname INTO owner_name
      FROM pg_proc AS procedure
      JOIN pg_roles AS role ON role.oid=procedure.proowner
     WHERE procedure.oid=routine::oid;
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, %I', routine, current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
    FOR role_row IN SELECT rolname FROM pg_roles WHERE rolname<>owner_name LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', routine, role_row.rolname);
    END LOOP;
    expected_role := CASE
      WHEN routine::text LIKE 'client_login_identity(%'
        OR routine::text LIKE 'client_self_password_identity(%'
        OR routine::text LIKE 'client_queue_password_reset(%'
      THEN 'agentnovas_client_auth'
      ELSE 'agentnovas_client_web'
    END;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=expected_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', routine, expected_role);
    END IF;
  END LOOP;
END
$identity_gateway_acl_convergence$;
