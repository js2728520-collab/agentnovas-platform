-- V3 Client identity completion: verified email, five concurrent devices,
-- network-change evidence and an authenticated all-session revoke gateway.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS device_hash text,
  ADD COLUMN IF NOT EXISTS network_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='sessions_device_hash_check' AND conrelid='sessions'::regclass
  ) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_device_hash_check
      CHECK (device_hash IS NULL OR device_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='sessions_network_key_check' AND conrelid='sessions'::regclass
  ) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_network_key_check
      CHECK (network_key IS NULL OR (length(network_key) BETWEEN 1 AND 160));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_client_device_history
  ON sessions(user_id,device_hash,created_at DESC)
  WHERE app_audience='client' AND device_hash IS NOT NULL;

ALTER TABLE auth_rate_limit_buckets
  DROP CONSTRAINT IF EXISTS auth_rate_limit_buckets_action_check;
ALTER TABLE auth_rate_limit_buckets
  ADD CONSTRAINT auth_rate_limit_buckets_action_check
  CHECK (action IN (
    'login','register','verify_email','forgot_password','reset_password',
    'mfa_verify','bootstrap'
  ));

ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_secret_metadata_check;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_secret_metadata_check
  CHECK (
    (secret_kind IS NULL AND secret_expires_at IS NULL)
    OR (
      secret_kind=template_key
      AND secret_kind IN ('verify_email','reset_password','internal_account_invite')
      AND secret_expires_at IS NOT NULL
    )
  );

-- New customer identities remain pending until the email bearer capability is
-- consumed. Existing customers are not silently reclassified by this migration.
CREATE OR REPLACE FUNCTION client_insert_invited_customer(
  user_id_input text,email_input text,phone_input text,password_hash_input text,
  invitation_id_input text,invitation_code_hash_input text
) RETURNS TABLE(kind text,owner_employee_id text,organization_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE invitation_row invitations%ROWTYPE;
BEGIN
  SELECT * INTO invitation_row FROM invitations
   WHERE id=invitation_id_input AND code_hash=invitation_code_hash_input AND status='active'
   FOR UPDATE;
  IF NOT FOUND OR invitation_row.kind NOT IN ('employee_reusable','public_pool_single_use') THEN
    RETURN;
  END IF;
  INSERT INTO users(id,email,phone,password_hash,role,organization_id,status)
  VALUES(
    user_id_input,email_input,phone_input,password_hash_input,'customer',
    CASE WHEN invitation_row.kind='public_pool_single_use' THEN NULL ELSE invitation_row.organization_id END,
    'pending'
  );
  RETURN QUERY SELECT invitation_row.kind,invitation_row.owner_employee_id,
    CASE WHEN invitation_row.kind='public_pool_single_use' THEN NULL ELSE invitation_row.organization_id END;
END
$function$;

CREATE OR REPLACE FUNCTION client_queue_registration_email_verification(
  user_id_input text,token_id_input text,token_hash_input text,expires_at_input timestamptz,
  delivery_id_input text,payload_input text,scheduled_at_input timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
BEGIN
  PERFORM 1 FROM users
   WHERE id=user_id_input AND role='customer' AND status IN ('pending','active') AND email_verified_at IS NULL
   FOR UPDATE;
  IF NOT FOUND OR length(token_hash_input)<>64 OR expires_at_input<=scheduled_at_input THEN
    RETURN false;
  END IF;
  UPDATE auth_tokens SET used_at=scheduled_at_input::text
   WHERE user_id=user_id_input AND purpose='verify_email' AND token_audience='client' AND used_at IS NULL;
  INSERT INTO auth_tokens(id,user_id,token_hash,purpose,token_audience,expires_at)
  VALUES(token_id_input,user_id_input,token_hash_input,'verify_email','client',expires_at_input::text);
  INSERT INTO notification_deliveries(
    id,user_id,channel,category,template_key,payload_json,status,scheduled_at,
    dedupe_key,secret_kind,secret_expires_at
  ) VALUES(
    delivery_id_input,user_id_input,'email','security','verify_email',payload_input,
    'queued',scheduled_at_input::text,'verify-email:'||token_id_input,
    'verify_email',expires_at_input
  );
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION client_queue_email_verification_by_email(
  email_input text,token_id_input text,token_hash_input text,expires_at_input timestamptz,
  delivery_id_input text,payload_input text,scheduled_at_input timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE account_id text;
BEGIN
  SELECT id INTO account_id FROM users
   WHERE lower(email)=lower(email_input) AND role='customer' AND status IN ('pending','active')
     AND email_verified_at IS NULL
   ORDER BY id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN client_queue_registration_email_verification(
    account_id,token_id_input,token_hash_input,expires_at_input,
    delivery_id_input,payload_input,scheduled_at_input
  );
END
$function$;

CREATE OR REPLACE FUNCTION client_complete_login_v3(
  user_id_input text,
  expected_password_hash_input text,
  replacement_password_hash_input text,
  session_id_input text,
  session_token_hash_input text,
  expires_at_input timestamptz,
  mfa_level_input text,
  last_seen_at_input timestamptz,
  idle_expires_at_input timestamptz,
  absolute_expires_at_input timestamptz,
  ip_address_input text,
  user_agent_input text,
  device_hash_input text,
  network_key_input text
) RETURNS TABLE(
  completed boolean,
  failure_code text,
  new_device boolean,
  unusual_network boolean,
  active_devices integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  known_device boolean;
  changed_network boolean;
  device_count integer;
BEGIN
  IF mfa_level_input NOT IN ('none','primary')
    OR length(session_token_hash_input)<>64
    OR device_hash_input !~ '^[a-f0-9]{64}$'
    OR length(network_key_input) NOT BETWEEN 1 AND 160
  THEN
    RETURN QUERY SELECT false,'INVALID_SESSION_INPUT',false,false,0;
    RETURN;
  END IF;

  PERFORM 1 FROM users
   WHERE id=user_id_input AND role='customer' AND status='active'
     AND email_verified_at IS NOT NULL AND password_hash=expected_password_hash_input
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'ACCOUNT_STATE_CHANGED',false,false,0;
    RETURN;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM sessions
     WHERE user_id=user_id_input AND app_audience='client' AND device_hash=device_hash_input
  ) INTO known_device;
  SELECT EXISTS(
    SELECT 1 FROM sessions
     WHERE user_id=user_id_input AND app_audience='client' AND device_hash=device_hash_input
       AND network_key IS NOT NULL AND network_key<>'unattributed'
       AND network_key_input<>'unattributed' AND network_key<>network_key_input
  ) INTO changed_network;

  UPDATE sessions SET revoked_at=last_seen_at_input::text
   WHERE user_id=user_id_input AND app_audience='client' AND device_hash=device_hash_input
     AND revoked_at IS NULL;

  SELECT count(DISTINCT COALESCE(device_hash,'legacy:'||id))::integer INTO device_count
    FROM sessions
   WHERE user_id=user_id_input AND app_audience='client' AND revoked_at IS NULL
     AND expires_at::timestamptz>last_seen_at_input
     AND idle_expires_at>last_seen_at_input AND absolute_expires_at>last_seen_at_input;

  IF device_count>=5 THEN
    RETURN QUERY SELECT false,'DEVICE_LIMIT_REACHED',NOT known_device,false,device_count;
    RETURN;
  END IF;

  IF replacement_password_hash_input IS NOT NULL AND replacement_password_hash_input<>'' THEN
    UPDATE users SET password_hash=replacement_password_hash_input,updated_at=last_seen_at_input::text
     WHERE id=user_id_input AND password_hash=expected_password_hash_input;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false,'ACCOUNT_STATE_CHANGED',false,false,device_count;
      RETURN;
    END IF;
  END IF;

  INSERT INTO sessions(
    id,user_id,token_hash,app_audience,expires_at,mfa_level,last_seen_at,
    idle_expires_at,absolute_expires_at,ip_address,user_agent,device_hash,network_key
  ) VALUES(
    session_id_input,user_id_input,session_token_hash_input,'client',expires_at_input::text,
    mfa_level_input,last_seen_at_input,idle_expires_at_input,absolute_expires_at_input,
    ip_address_input,user_agent_input,device_hash_input,network_key_input
  );
  RETURN QUERY SELECT true,NULL::text,NOT known_device,(known_device AND changed_network),device_count+1;
END
$function$;

CREATE OR REPLACE FUNCTION client_revoke_all_sessions(
  session_token_hash_input text,
  revoked_at_input timestamptz
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE actor_id text; revoked_count integer;
BEGIN
  SELECT session.user_id INTO actor_id
    FROM sessions AS session JOIN users AS account ON account.id=session.user_id
   WHERE length(session_token_hash_input)=64 AND session.token_hash=session_token_hash_input
     AND session.app_audience='client' AND session.revoked_at IS NULL
     AND session.expires_at::timestamptz>revoked_at_input
     AND session.idle_expires_at>revoked_at_input AND session.absolute_expires_at>revoked_at_input
     AND account.role='customer' AND account.status='active'
   FOR UPDATE OF account;
  IF NOT FOUND THEN RETURN 0; END IF;
  UPDATE sessions SET revoked_at=revoked_at_input::text
   WHERE user_id=actor_id AND app_audience='client' AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_count=ROW_COUNT;
  RETURN revoked_count;
END
$function$;

DO $client_security_gateway_acl$
DECLARE routine regprocedure; role_row record; owner_name text; expected_role text;
BEGIN
  FOR routine IN SELECT unnest(ARRAY[
    'client_complete_login_v3(text,text,text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,text,text)'::regprocedure,
    'client_revoke_all_sessions(text,timestamp with time zone)'::regprocedure,
    'client_queue_registration_email_verification(text,text,text,timestamp with time zone,text,text,timestamp with time zone)'::regprocedure,
    'client_queue_email_verification_by_email(text,text,text,timestamp with time zone,text,text,timestamp with time zone)'::regprocedure
  ]) LOOP
    SELECT role.rolname INTO owner_name FROM pg_proc AS procedure
      JOIN pg_roles AS role ON role.oid=procedure.proowner WHERE procedure.oid=routine::oid;
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, %I',routine,current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
    FOR role_row IN SELECT rolname FROM pg_roles WHERE rolname<>owner_name LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,role_row.rolname);
    END LOOP;
    expected_role := CASE
      WHEN routine::text LIKE 'client_queue_email_verification_by_email(%'
      THEN 'agentnovas_client_auth' ELSE 'agentnovas_client_web' END;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=expected_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',routine,expected_role);
    END IF;
  END LOOP;
END
$client_security_gateway_acl$;
