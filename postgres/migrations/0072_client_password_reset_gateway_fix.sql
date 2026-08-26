-- `client_consume_password_reset` returns a column named `user_id`. In PL/pgSQL,
-- that output column is also a variable, so the unqualified `WHERE user_id=...`
-- from migration 0040 becomes ambiguous after the target row is found and the
-- entire Client password-reset transaction fails with PostgreSQL 42702.
--
-- Replace the function forward-only (do not rewrite migration 0040) and qualify
-- every mutable table reference. The public contract and least-privilege caller
-- remain unchanged.

CREATE OR REPLACE FUNCTION client_consume_password_reset(
  token_hash_input text,password_hash_input text,now_input timestamptz
) RETURNS TABLE(user_id text,account_activated boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE target_account_id text; previous_status text;
BEGIN
  SELECT account.id,account.status INTO target_account_id,previous_status
    FROM auth_tokens AS reset_token
    JOIN users AS account ON account.id=reset_token.user_id
   WHERE reset_token.token_hash=token_hash_input
     AND reset_token.purpose='reset_password'
     AND reset_token.token_audience='client'
     AND reset_token.used_at IS NULL
     AND reset_token.expires_at::timestamptz>now_input
     AND account.role='customer'
   FOR UPDATE OF reset_token,account;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE auth_tokens AS sibling_token
     SET used_at=now_input::text
   WHERE sibling_token.user_id=target_account_id
     AND sibling_token.purpose='reset_password'
     AND sibling_token.token_audience='client'
     AND sibling_token.used_at IS NULL;

  UPDATE users AS account
     SET password_hash=password_hash_input,
         status=CASE WHEN account.status='pending' THEN 'active' ELSE account.status END,
         email_verified_at=CASE WHEN account.status='pending' THEN now_input::text ELSE account.email_verified_at END,
         updated_at=now_input::text
   WHERE account.id=target_account_id;

  UPDATE sessions AS customer_session
     SET revoked_at=now_input::text
   WHERE customer_session.user_id=target_account_id
     AND customer_session.app_audience='client'
     AND customer_session.revoked_at IS NULL;

  RETURN QUERY SELECT target_account_id,previous_status='pending';
END
$function$;

DO $client_password_reset_gateway_acl$
DECLARE routine regprocedure; role_row record; owner_name text;
BEGIN
  routine := 'client_consume_password_reset(text,text,timestamp with time zone)'::regprocedure;
  SELECT role.rolname INTO owner_name
    FROM pg_proc AS procedure
    JOIN pg_roles AS role ON role.oid=procedure.proowner
   WHERE procedure.oid=routine::oid;
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, %I',routine,current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
  FOR role_row IN SELECT rolname FROM pg_roles WHERE rolname<>owner_name LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,role_row.rolname);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agentnovas_client_web',routine);
  END IF;
END
$client_password_reset_gateway_acl$;
