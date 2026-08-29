-- A Client device is active only while every session validity bound remains
-- open. The original gateway filtered revoked and absolute expiry but could
-- still return a session after its normal or idle timeout.
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
  WHERE session.user_id=actor.user_id AND session.app_audience='client'
    AND session.revoked_at IS NULL
    AND session.expires_at::timestamptz>now_input
    AND session.idle_expires_at>now_input
    AND session.absolute_expires_at>now_input
  ORDER BY COALESCE(session.last_seen_at,session.created_at::timestamptz) DESC,session.id DESC
  LIMIT 50
$function$;
