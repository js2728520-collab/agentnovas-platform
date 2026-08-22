-- Keep the shared Client process role out of internal identities and audiences.
-- Policies depend only on PostgreSQL current_user, which is fixed by DATABASE_URL;
-- no request/session GUC is trusted as an authorization boundary.

-- Functions are installed into the migration's explicitly selected schema.
-- The migration runner executes each file in a transaction; deferring body
-- validation lets isolated quality schemas install the same fixed-path gateway.
SET LOCAL check_function_bodies = off;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_totp_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_identity_base_access ON users;
CREATE POLICY users_identity_base_access ON users
  FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS users_client_identity_partition ON users;
CREATE POLICY users_client_identity_partition ON users
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web','agentnovas_notification_worker')
    OR (current_user = 'agentnovas_client_web' AND role = 'customer')
  )
  WITH CHECK (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web','agentnovas_notification_worker')
    OR (current_user = 'agentnovas_client_web' AND role = 'customer')
  );

DROP POLICY IF EXISTS sessions_identity_base_access ON sessions;
CREATE POLICY sessions_identity_base_access ON sessions
  FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sessions_client_identity_partition ON sessions;
CREATE POLICY sessions_client_identity_partition ON sessions
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR (
      current_user = 'agentnovas_client_web'
      AND
      app_audience = 'client'
      AND EXISTS (SELECT 1 FROM users AS account WHERE account.id = sessions.user_id AND account.role = 'customer')
    )
  )
  WITH CHECK (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR (
      current_user = 'agentnovas_client_web'
      AND
      app_audience = 'client'
      AND EXISTS (SELECT 1 FROM users AS account WHERE account.id = sessions.user_id AND account.role = 'customer')
    )
  );

DROP POLICY IF EXISTS auth_tokens_identity_base_access ON auth_tokens;
CREATE POLICY auth_tokens_identity_base_access ON auth_tokens
  FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS auth_tokens_client_identity_partition ON auth_tokens;
CREATE POLICY auth_tokens_client_identity_partition ON auth_tokens
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR (
      current_user = 'agentnovas_client_web'
      AND
      token_audience = 'client'
      AND EXISTS (SELECT 1 FROM users AS account WHERE account.id = auth_tokens.user_id AND account.role = 'customer')
    )
  )
  WITH CHECK (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR (
      current_user = 'agentnovas_client_web'
      AND
      token_audience = 'client'
      AND EXISTS (SELECT 1 FROM users AS account WHERE account.id = auth_tokens.user_id AND account.role = 'customer')
    )
  );

DROP POLICY IF EXISTS mfa_totp_identity_base_access ON user_mfa_totp_credentials;
CREATE POLICY mfa_totp_identity_base_access ON user_mfa_totp_credentials
  FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS user_mfa_totp_credentials_client_identity_partition ON user_mfa_totp_credentials;
CREATE POLICY user_mfa_totp_credentials_client_identity_partition ON user_mfa_totp_credentials
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR EXISTS (
      SELECT 1 FROM users AS account
      WHERE current_user = 'agentnovas_client_web'
        AND account.id = user_mfa_totp_credentials.user_id AND account.role = 'customer'
    )
  )
  WITH CHECK (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR EXISTS (
      SELECT 1 FROM users AS account
      WHERE current_user = 'agentnovas_client_web'
        AND account.id = user_mfa_totp_credentials.user_id AND account.role = 'customer'
    )
  );

DROP POLICY IF EXISTS mfa_recovery_identity_base_access ON user_mfa_recovery_codes;
CREATE POLICY mfa_recovery_identity_base_access ON user_mfa_recovery_codes
  FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS user_mfa_recovery_codes_client_identity_partition ON user_mfa_recovery_codes;
CREATE POLICY user_mfa_recovery_codes_client_identity_partition ON user_mfa_recovery_codes
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR EXISTS (
      SELECT 1 FROM users AS account
      WHERE current_user = 'agentnovas_client_web'
        AND account.id = user_mfa_recovery_codes.user_id AND account.role = 'customer'
    )
  )
  WITH CHECK (
    current_user IN ('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web')
    OR EXISTS (
      SELECT 1 FROM users AS account
      WHERE current_user = 'agentnovas_client_web'
        AND account.id = user_mfa_recovery_codes.user_id AND account.role = 'customer'
    )
  );

-- Registration needs two internal reporting-chain identifiers for attribution,
-- but the Client role must never SELECT internal user rows. The function returns
-- only the nearest manager/supervisor for one still-active invitation whose
-- high-entropy code hash is already held and locked by the caller.
CREATE OR REPLACE FUNCTION client_registration_attribution(
  invitation_id_input text,
  invitation_code_hash_input text
) RETURNS TABLE(manager_id text, supervisor_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH RECURSIVE valid_invitation AS (
    SELECT invitation.owner_employee_id
      FROM invitations AS invitation
     WHERE invitation.id = invitation_id_input
       AND invitation.code_hash = invitation_code_hash_input
       AND invitation.status = 'active'
       AND invitation.kind = 'employee_reusable'
       AND invitation.owner_employee_id IS NOT NULL
  ), reporting_chain AS (
    SELECT account.id,account.role,account.reports_to_user_id,0 AS depth
      FROM users AS account
      JOIN valid_invitation AS invitation ON invitation.owner_employee_id = account.id
    UNION ALL
    SELECT parent.id,parent.role,parent.reports_to_user_id,chain.depth + 1
      FROM reporting_chain AS chain
      JOIN users AS parent ON parent.id = chain.reports_to_user_id
     WHERE chain.depth < 6
  )
  SELECT
    (SELECT chain.id FROM reporting_chain AS chain WHERE chain.role = 'manager' ORDER BY chain.depth,chain.id LIMIT 1),
    (SELECT chain.id FROM reporting_chain AS chain WHERE chain.role = 'supervisor' ORDER BY chain.depth,chain.id LIMIT 1)
  FROM valid_invitation
$function$;

REVOKE ALL ON FUNCTION client_registration_attribution(text,text) FROM PUBLIC;

-- The shared Client connection role is not a per-user principal. It therefore
-- receives no direct identity-table access after deployment. These narrowly
-- scoped gateways bind authenticated operations to an unguessable Client
-- session token hash and unauthenticated operations to an exact login,
-- invitation or reset-token capability.

CREATE OR REPLACE FUNCTION client_login_identity(phone_input text,email_input text,username_input text)
RETURNS TABLE(user_json jsonb, has_active_mfa boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  SELECT to_jsonb(account),EXISTS(
    SELECT 1 FROM user_mfa_totp_credentials AS credential
     WHERE credential.user_id=account.id AND credential.status='active'
  )
  FROM users AS account
  WHERE account.role='customer'
    AND (
      account.phone=phone_input
      OR lower(account.email)=lower(email_input)
      OR account.username=username_input
    )
  ORDER BY account.id
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION client_session_identity(
  session_token_hash_input text,
  now_input timestamptz
) RETURNS TABLE(user_json jsonb, session_json jsonb, has_active_mfa boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  SELECT (to_jsonb(account)-'password_hash')||jsonb_build_object('password_hash',''),to_jsonb(session),EXISTS(
    SELECT 1 FROM user_mfa_totp_credentials AS credential
     WHERE credential.user_id=account.id AND credential.status='active'
  )
  FROM sessions AS session
  JOIN users AS account ON account.id=session.user_id
  WHERE length(session_token_hash_input)=64
    AND session.token_hash=session_token_hash_input
    AND session.app_audience='client'
    AND session.revoked_at IS NULL
    AND session.expires_at::timestamptz>now_input
    AND session.idle_expires_at>now_input
    AND session.absolute_expires_at>now_input
    AND account.role='customer'
    AND account.status='active'
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION client_self_password_identity(
  session_token_hash_input text,
  now_input timestamptz
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  SELECT account.password_hash
    FROM sessions AS session JOIN users AS account ON account.id=session.user_id
   WHERE length(session_token_hash_input)=64 AND session.token_hash=session_token_hash_input
     AND session.app_audience='client' AND session.revoked_at IS NULL
     AND session.expires_at::timestamptz>now_input AND session.idle_expires_at>now_input
     AND session.absolute_expires_at>now_input AND account.role='customer' AND account.status='active'
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION client_touch_session(
  session_token_hash_input text,
  touched_at_input timestamptz,
  idle_expires_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH touched AS (
    UPDATE sessions AS session
       SET last_seen_at=touched_at_input,idle_expires_at=LEAST(idle_expires_at_input,session.absolute_expires_at)
     FROM users AS account
     WHERE length(session_token_hash_input)=64
       AND session.token_hash=session_token_hash_input
       AND session.app_audience='client'
       AND session.revoked_at IS NULL
       AND session.expires_at::timestamptz>touched_at_input
       AND session.idle_expires_at>touched_at_input AND session.absolute_expires_at>touched_at_input
       AND account.id=session.user_id AND account.role='customer' AND account.status='active'
     RETURNING session.id
  ) SELECT EXISTS(SELECT 1 FROM touched)
$function$;

CREATE OR REPLACE FUNCTION client_complete_login(
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
  user_agent_input text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
BEGIN
  IF mfa_level_input NOT IN ('none','primary') OR length(session_token_hash_input) <> 64 THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM users
   WHERE id=user_id_input AND role='customer' AND status='active'
     AND password_hash=expected_password_hash_input
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF replacement_password_hash_input IS NOT NULL AND replacement_password_hash_input <> '' THEN
    UPDATE users SET password_hash=replacement_password_hash_input,updated_at=last_seen_at_input::text
     WHERE id=user_id_input AND password_hash=expected_password_hash_input;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  INSERT INTO sessions(
    id,user_id,token_hash,app_audience,expires_at,mfa_level,last_seen_at,
    idle_expires_at,absolute_expires_at,ip_address,user_agent
  ) VALUES(
    session_id_input,user_id_input,session_token_hash_input,'client',expires_at_input::text,
    mfa_level_input,last_seen_at_input,idle_expires_at_input,absolute_expires_at_input,
    ip_address_input,user_agent_input
  );
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION client_registration_conflicts(phone_input text,email_input text)
RETURNS TABLE(phone_exists boolean,email_exists boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  SELECT EXISTS(SELECT 1 FROM users WHERE phone=phone_input),
         EXISTS(SELECT 1 FROM users WHERE lower(email)=lower(email_input))
$function$;

CREATE OR REPLACE FUNCTION client_registration_invitation(invitation_code_hash_input text)
RETURNS TABLE(id text,kind text,owner_employee_id text,organization_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
BEGIN
  RETURN QUERY
  SELECT invitation.id,invitation.kind,invitation.owner_employee_id,invitation.organization_id
    FROM invitations AS invitation
   WHERE invitation.code_hash=invitation_code_hash_input AND invitation.status='active'
   ORDER BY invitation.id LIMIT 1
   FOR UPDATE;
END
$function$;

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
    'active'
  );
  RETURN QUERY SELECT invitation_row.kind,invitation_row.owner_employee_id,
    CASE WHEN invitation_row.kind='public_pool_single_use' THEN NULL ELSE invitation_row.organization_id END;
END
$function$;

CREATE OR REPLACE FUNCTION client_claim_registration_invitation(
  invitation_id_input text,invitation_code_hash_input text,user_id_input text,used_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH claimed AS (
    UPDATE invitations
       SET status='used',used_by_user_id=user_id_input,used_at=used_at_input::text,updated_at=used_at_input::text
     WHERE id=invitation_id_input AND code_hash=invitation_code_hash_input
       AND kind='public_pool_single_use' AND status='active'
       AND EXISTS(SELECT 1 FROM users WHERE id=user_id_input AND role='customer')
     RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM claimed)
$function$;

CREATE OR REPLACE FUNCTION client_profile_conflicts(
  session_token_hash_input text,username_input text,nickname_input text,phone_input text
) RETURNS TABLE(username_exists boolean,nickname_exists boolean,phone_exists boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH actor AS (
    SELECT session.user_id FROM sessions AS session
    JOIN users AS account ON account.id=session.user_id
    WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
      AND session.revoked_at IS NULL AND session.expires_at::timestamptz>CURRENT_TIMESTAMP
      AND session.idle_expires_at>CURRENT_TIMESTAMP AND session.absolute_expires_at>CURRENT_TIMESTAMP
      AND account.role='customer' AND account.status='active'
  )
  SELECT
    EXISTS(SELECT 1 FROM users,actor WHERE users.id<>actor.user_id AND (lower(users.username)=lower(username_input) OR lower(users.nickname)=lower(username_input))),
    EXISTS(SELECT 1 FROM users,actor WHERE users.id<>actor.user_id AND (lower(users.username)=lower(nickname_input) OR lower(users.nickname)=lower(nickname_input))),
    EXISTS(SELECT 1 FROM users,actor WHERE users.id<>actor.user_id AND users.phone=phone_input)
$function$;

CREATE OR REPLACE FUNCTION client_update_profile(
  session_token_hash_input text,expected_password_hash_input text,
  username_input text,nickname_input text,avatar_url_input text,phone_input text,
  date_of_birth_input text,gender_input text,timezone_input text,updated_at_input timestamptz
) RETURNS TABLE(user_json jsonb,other_sessions_revoked integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE actor_id text; current_session_id text; revoked_count integer;
BEGIN
  SELECT account.id,session.id INTO actor_id,current_session_id
    FROM sessions AS session JOIN users AS account ON account.id=session.user_id
   WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
     AND session.revoked_at IS NULL AND session.expires_at::timestamptz>CURRENT_TIMESTAMP
     AND session.idle_expires_at>CURRENT_TIMESTAMP AND session.absolute_expires_at>CURRENT_TIMESTAMP
     AND account.role='customer' AND account.status='active'
     AND account.password_hash=expected_password_hash_input
   FOR UPDATE OF account;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE users SET username=NULLIF(username_input,''),nickname=nickname_input,
    avatar_url=avatar_url_input,phone=phone_input,date_of_birth=date_of_birth_input,
    gender=gender_input,timezone=timezone_input,updated_at=updated_at_input::text
   WHERE id=actor_id;
  UPDATE sessions SET revoked_at=updated_at_input::text
   WHERE user_id=actor_id AND app_audience='client' AND id<>current_session_id AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  RETURN QUERY SELECT to_jsonb(account),revoked_count FROM users AS account WHERE account.id=actor_id;
END
$function$;

CREATE OR REPLACE FUNCTION client_change_password(
  session_token_hash_input text,expected_password_hash_input text,new_password_hash_input text,changed_at_input timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE actor_id text;
BEGIN
  SELECT account.id INTO actor_id
    FROM sessions AS session JOIN users AS account ON account.id=session.user_id
   WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
     AND session.revoked_at IS NULL AND session.expires_at::timestamptz>changed_at_input
     AND session.idle_expires_at>changed_at_input AND session.absolute_expires_at>changed_at_input
     AND account.role='customer' AND account.status='active'
     AND account.password_hash=expected_password_hash_input
   FOR UPDATE OF account;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE users SET password_hash=new_password_hash_input,updated_at=changed_at_input::text WHERE id=actor_id;
  UPDATE sessions SET revoked_at=changed_at_input::text
   WHERE user_id=actor_id AND app_audience='client' AND revoked_at IS NULL;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION client_list_sessions(session_token_hash_input text,now_input timestamptz)
RETURNS TABLE(id text,app_audience text,created_at text,last_seen_at timestamptz,
  idle_expires_at timestamptz,absolute_expires_at timestamptz,ip_address text,user_agent text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH actor AS (
    SELECT session.user_id FROM sessions AS session JOIN users AS account ON account.id=session.user_id
     WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
       AND session.revoked_at IS NULL AND session.expires_at::timestamptz>now_input
       AND session.idle_expires_at>now_input AND session.absolute_expires_at>now_input
       AND account.role='customer' AND account.status='active'
  )
  SELECT session.id,session.app_audience,session.created_at,session.last_seen_at,
    session.idle_expires_at,session.absolute_expires_at,session.ip_address,session.user_agent
  FROM sessions AS session,actor
  WHERE session.user_id=actor.user_id AND session.app_audience='client' AND session.revoked_at IS NULL
    AND session.absolute_expires_at>now_input
  ORDER BY COALESCE(session.last_seen_at,session.created_at::timestamptz) DESC,session.id DESC LIMIT 50
$function$;

CREATE OR REPLACE FUNCTION client_revoke_session(
  session_token_hash_input text,target_session_id_input text,revoked_at_input timestamptz
) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH actor AS (
    SELECT session.id,session.user_id FROM sessions AS session JOIN users AS account ON account.id=session.user_id
     WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
       AND session.revoked_at IS NULL AND session.expires_at::timestamptz>revoked_at_input
       AND session.idle_expires_at>revoked_at_input AND session.absolute_expires_at>revoked_at_input
       AND account.role='customer' AND account.status='active'
  ),revoked AS (
    UPDATE sessions AS target SET revoked_at=revoked_at_input::text FROM actor
     WHERE target.id=target_session_id_input AND target.user_id=actor.user_id
       AND target.app_audience='client' AND target.id<>actor.id AND target.revoked_at IS NULL
     RETURNING target.app_audience
  ) SELECT app_audience FROM revoked
$function$;

CREATE OR REPLACE FUNCTION client_revoke_current_session(session_token_hash_input text,revoked_at_input timestamptz)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH revoked AS (
    UPDATE sessions AS session SET revoked_at=revoked_at_input::text
     FROM users AS account
     WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
       AND session.revoked_at IS NULL AND session.expires_at::timestamptz>revoked_at_input
       AND session.idle_expires_at>revoked_at_input AND session.absolute_expires_at>revoked_at_input
       AND account.id=session.user_id AND account.role='customer'
     RETURNING session.id
  ) SELECT EXISTS(SELECT 1 FROM revoked)
$function$;

CREATE OR REPLACE FUNCTION client_mfa_start(
  session_token_hash_input text,encrypted_secret_input text,created_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH actor AS (
    SELECT session.user_id FROM sessions AS session JOIN users AS account ON account.id=session.user_id
     WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
       AND session.revoked_at IS NULL AND session.expires_at::timestamptz>created_at_input
       AND session.idle_expires_at>created_at_input AND session.absolute_expires_at>created_at_input
       AND account.role='customer' AND account.status='active'
  ),changed AS (
    INSERT INTO user_mfa_totp_credentials(user_id,encrypted_secret,encryption_key_version,status,created_at,updated_at)
    SELECT actor.user_id,encrypted_secret_input,1,'pending',created_at_input,created_at_input FROM actor
    ON CONFLICT (user_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret,
      encryption_key_version=EXCLUDED.encryption_key_version,status='pending',last_accepted_counter=NULL,
      enabled_at=NULL,disabled_at=NULL,updated_at=EXCLUDED.updated_at
    WHERE user_mfa_totp_credentials.status<>'active'
    RETURNING user_id
  ) SELECT EXISTS(SELECT 1 FROM changed)
$function$;

CREATE OR REPLACE FUNCTION client_mfa_credential(session_token_hash_input text,status_input text)
RETURNS TABLE(encrypted_secret text,last_accepted_counter bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  SELECT credential.encrypted_secret,credential.last_accepted_counter
    FROM sessions AS session JOIN users AS account ON account.id=session.user_id
    JOIN user_mfa_totp_credentials AS credential ON credential.user_id=account.id
   WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
     AND session.revoked_at IS NULL AND session.expires_at::timestamptz>CURRENT_TIMESTAMP
     AND session.idle_expires_at>CURRENT_TIMESTAMP AND session.absolute_expires_at>CURRENT_TIMESTAMP
     AND account.role='customer' AND account.status='active'
     AND credential.status=status_input
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION client_mfa_accept_totp(
  session_token_hash_input text,counter_input bigint,accepted_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH actor AS (
    SELECT session.user_id FROM sessions AS session JOIN users AS account ON account.id=session.user_id
     WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
       AND session.revoked_at IS NULL AND session.expires_at::timestamptz>accepted_at_input
       AND session.idle_expires_at>accepted_at_input AND session.absolute_expires_at>accepted_at_input
       AND account.role='customer' AND account.status='active'
  ),changed AS (
    UPDATE user_mfa_totp_credentials AS credential
       SET last_accepted_counter=counter_input,updated_at=accepted_at_input
      FROM actor WHERE credential.user_id=actor.user_id AND credential.status='active'
       AND (credential.last_accepted_counter IS NULL OR credential.last_accepted_counter<counter_input)
     RETURNING credential.user_id
  ) SELECT EXISTS(SELECT 1 FROM changed)
$function$;

CREATE OR REPLACE FUNCTION client_mfa_consume_recovery(
  session_token_hash_input text,code_hash_input text,used_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH actor AS (
    SELECT session.user_id FROM sessions AS session JOIN users AS account ON account.id=session.user_id
     WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
       AND session.revoked_at IS NULL AND session.expires_at::timestamptz>used_at_input
       AND session.idle_expires_at>used_at_input AND session.absolute_expires_at>used_at_input
       AND account.role='customer' AND account.status='active'
  ),changed AS (
    UPDATE user_mfa_recovery_codes AS recovery SET used_at=used_at_input FROM actor
     WHERE recovery.user_id=actor.user_id AND recovery.code_hash=code_hash_input AND recovery.used_at IS NULL
     RETURNING recovery.id
  ) SELECT EXISTS(SELECT 1 FROM changed)
$function$;

CREATE OR REPLACE FUNCTION client_mfa_replace_recovery(
  session_token_hash_input text,codes_input jsonb,replaced_at_input timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE actor_id text;
BEGIN
  SELECT session.user_id INTO actor_id FROM sessions AS session JOIN users AS account ON account.id=session.user_id
   WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
     AND session.revoked_at IS NULL AND session.expires_at::timestamptz>replaced_at_input
     AND session.idle_expires_at>replaced_at_input AND session.absolute_expires_at>replaced_at_input
     AND account.role='customer' AND account.status='active';
  IF NOT FOUND OR jsonb_typeof(codes_input)<>'array' OR jsonb_array_length(codes_input)>20 THEN RETURN false; END IF;
  DELETE FROM user_mfa_recovery_codes WHERE user_id=actor_id AND used_at IS NULL;
  INSERT INTO user_mfa_recovery_codes(id,user_id,code_hash,created_at)
  SELECT item.id,actor_id,item.code_hash,replaced_at_input
    FROM jsonb_to_recordset(codes_input) AS item(id text,code_hash text);
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION client_mfa_complete_enrollment(
  session_token_hash_input text,counter_input bigint,idle_expires_at_input timestamptz,
  codes_input jsonb,completed_at_input timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE actor_id text; session_id_value text;
BEGIN
  SELECT session.user_id,session.id INTO actor_id,session_id_value
    FROM sessions AS session JOIN users AS account ON account.id=session.user_id
   WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
     AND session.revoked_at IS NULL AND session.expires_at::timestamptz>completed_at_input
     AND session.idle_expires_at>completed_at_input AND session.absolute_expires_at>completed_at_input
     AND session.mfa_level='primary'
     AND account.role='customer' AND account.status='active' FOR UPDATE OF session;
  IF NOT FOUND OR jsonb_typeof(codes_input)<>'array' OR jsonb_array_length(codes_input)>20 THEN RETURN false; END IF;
  UPDATE user_mfa_totp_credentials SET status='active',last_accepted_counter=counter_input,
    enabled_at=completed_at_input,updated_at=completed_at_input
   WHERE user_id=actor_id AND status='pending';
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM user_mfa_recovery_codes WHERE user_id=actor_id;
  INSERT INTO user_mfa_recovery_codes(id,user_id,code_hash,created_at)
  SELECT item.id,actor_id,item.code_hash,completed_at_input
    FROM jsonb_to_recordset(codes_input) AS item(id text,code_hash text);
  UPDATE sessions SET mfa_level='totp',mfa_verified_at=completed_at_input,last_seen_at=completed_at_input,
    idle_expires_at=LEAST(idle_expires_at_input,absolute_expires_at)
   WHERE id=session_id_value AND revoked_at IS NULL;
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION client_mfa_mark_session_verified(
  session_token_hash_input text,mfa_level_input text,verified_at_input timestamptz,idle_expires_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH changed AS (
    UPDATE sessions AS session SET mfa_level=mfa_level_input,mfa_verified_at=verified_at_input,
      last_seen_at=verified_at_input,idle_expires_at=LEAST(idle_expires_at_input,session.absolute_expires_at)
     FROM users AS account
     WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
       AND session.revoked_at IS NULL AND session.expires_at::timestamptz>verified_at_input
       AND session.idle_expires_at>verified_at_input AND session.absolute_expires_at>verified_at_input
       AND mfa_level_input IN ('totp','recovery')
       AND account.id=session.user_id AND account.role='customer' AND account.status='active'
     RETURNING session.id
  ) SELECT EXISTS(SELECT 1 FROM changed)
$function$;

CREATE OR REPLACE FUNCTION client_mfa_recovery_status(session_token_hash_input text)
RETURNS TABLE(enabled_at timestamptz,remaining_recovery_codes bigint,last_recovery_code_created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  SELECT credential.enabled_at,count(recovery.id) FILTER(WHERE recovery.used_at IS NULL),max(recovery.created_at)
    FROM sessions AS session JOIN users AS account ON account.id=session.user_id
    JOIN user_mfa_totp_credentials AS credential ON credential.user_id=account.id
    LEFT JOIN user_mfa_recovery_codes AS recovery ON recovery.user_id=account.id
   WHERE session.token_hash=session_token_hash_input AND session.app_audience='client'
     AND session.revoked_at IS NULL AND session.expires_at::timestamptz>CURRENT_TIMESTAMP
     AND session.idle_expires_at>CURRENT_TIMESTAMP AND session.absolute_expires_at>CURRENT_TIMESTAMP
     AND account.role='customer' AND account.status='active'
     AND credential.status='active'
   GROUP BY credential.user_id,credential.enabled_at
$function$;

CREATE OR REPLACE FUNCTION client_queue_password_reset(
  email_input text,token_id_input text,token_hash_input text,expires_at_input timestamptz,
  delivery_id_input text,payload_input text,scheduled_at_input timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH target AS (SELECT id FROM users WHERE lower(email)=lower(email_input) AND role='customer' LIMIT 1),
  token AS (
    INSERT INTO auth_tokens(id,user_id,token_hash,purpose,token_audience,expires_at)
    SELECT token_id_input,target.id,token_hash_input,'reset_password','client',expires_at_input::text FROM target
    RETURNING user_id
  ),delivery AS (
    INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,scheduled_at,secret_kind,secret_expires_at)
    SELECT delivery_id_input,token.user_id,'email','login_security','reset_password',payload_input,
      scheduled_at_input,'reset_password',expires_at_input FROM token RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM delivery)
$function$;

CREATE OR REPLACE FUNCTION client_consume_password_reset(
  token_hash_input text,password_hash_input text,now_input timestamptz
) RETURNS TABLE(user_id text,account_activated boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE account_id text; previous_status text;
BEGIN
  SELECT account.id,account.status INTO account_id,previous_status
    FROM auth_tokens AS token JOIN users AS account ON account.id=token.user_id
   WHERE token.token_hash=token_hash_input AND token.purpose='reset_password' AND token.token_audience='client'
     AND token.used_at IS NULL AND token.expires_at::timestamptz>now_input
     AND account.role='customer' FOR UPDATE OF token,account;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE auth_tokens SET used_at=now_input::text
   WHERE user_id=account_id AND purpose='reset_password' AND token_audience='client' AND used_at IS NULL;
  UPDATE users SET password_hash=password_hash_input,
    status=CASE WHEN status='pending' THEN 'active' ELSE status END,
    email_verified_at=CASE WHEN status='pending' THEN now_input::text ELSE email_verified_at END,
    updated_at=now_input::text WHERE id=account_id;
  UPDATE sessions SET revoked_at=now_input::text
   WHERE user_id=account_id AND app_audience='client' AND revoked_at IS NULL;
  RETURN QUERY SELECT account_id,previous_status='pending';
END
$function$;

CREATE OR REPLACE FUNCTION client_verify_email(token_hash_input text,now_input timestamptz)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE account_id text; token_id_value text;
BEGIN
  SELECT account.id,token.id INTO account_id,token_id_value
    FROM auth_tokens AS token JOIN users AS account ON account.id=token.user_id
   WHERE token.token_hash=token_hash_input AND token.token_audience='client'
     AND token.purpose='verify_email' AND token.used_at IS NULL
     AND token.expires_at::timestamptz>now_input AND account.role='customer'
   FOR UPDATE OF token,account;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE auth_tokens SET used_at=now_input::text WHERE id=token_id_value;
  UPDATE users SET email_verified_at=now_input::text,status='active',updated_at=now_input::text WHERE id=account_id;
  RETURN account_id;
END
$function$;

DO $grant_surface$
DECLARE routine regprocedure;
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
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
  END LOOP;
END
$grant_surface$;
