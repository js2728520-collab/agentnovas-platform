-- Client MFA remains opt-in while enforcement is disabled. A normal Client
-- login therefore owns a complete `none` session rather than a primary-only
-- challenge session. Permit that authenticated session to finish enrollment;
-- active credentials remain immutable and completion still upgrades only the
-- exact current Client session.
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
     AND session.mfa_level IN ('none','primary')
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
