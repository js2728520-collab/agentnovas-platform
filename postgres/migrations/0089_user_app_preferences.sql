CREATE TABLE IF NOT EXISTS user_app_preferences (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_audience text NOT NULL CHECK (app_audience IN ('client','operations','maintenance')),
  locale text NOT NULL,
  theme_mode text NOT NULL DEFAULT 'system' CHECK (theme_mode IN ('system','light','dark')),
  theme_palette text NOT NULL DEFAULT 'classic' CHECK (theme_palette IN ('classic','harbor','forest')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,app_audience),
  CONSTRAINT user_app_preferences_locale_by_audience_check CHECK (
    (app_audience='client' AND locale IN ('en-US','zh-CN','zh-TW','ru-RU','es-ES','ja-JP','ko-KR'))
    OR (app_audience IN ('operations','maintenance') AND locale IN ('zh-CN','en-US'))
  )
);

CREATE INDEX IF NOT EXISTS idx_user_app_preferences_audience_updated
  ON user_app_preferences(app_audience,updated_at DESC);

INSERT INTO user_app_preferences(user_id,app_audience,locale)
SELECT account.id,'client',
  CASE WHEN account.locale IN ('en-US','zh-CN','zh-TW','ru-RU','es-ES','ja-JP','ko-KR')
    THEN account.locale ELSE 'en-US' END
FROM users AS account
WHERE account.role='customer'
ON CONFLICT (user_id,app_audience) DO NOTHING;

ALTER TABLE user_app_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_app_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_app_preferences_owner_gateway ON user_app_preferences;
CREATE POLICY user_app_preferences_owner_gateway ON user_app_preferences
  FOR ALL TO PUBLIC
  USING (current_user='agentnovas_migrator')
  WITH CHECK (current_user='agentnovas_migrator');

CREATE OR REPLACE FUNCTION user_app_preference_read(
  session_token_hash_input text,
  now_input timestamptz
)
RETURNS TABLE(
  user_id text,
  app_audience text,
  locale text,
  theme_mode text,
  theme_palette text,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
  WITH actor AS (
    SELECT account.id AS user_id,session.app_audience,account.locale AS legacy_locale
      FROM sessions AS session
      JOIN users AS account ON account.id=session.user_id
     WHERE session.token_hash=session_token_hash_input
       AND session.revoked_at IS NULL
       AND session.expires_at::timestamptz>now_input
       AND session.idle_expires_at>now_input
       AND session.absolute_expires_at>now_input
       AND account.status='active'
  )
  SELECT actor.user_id,actor.app_audience,
    COALESCE(preference.locale,
      CASE
        WHEN actor.app_audience='client' AND actor.legacy_locale IN ('en-US','zh-CN','zh-TW','ru-RU','es-ES','ja-JP','ko-KR') THEN actor.legacy_locale
        WHEN actor.app_audience='client' THEN 'en-US'
        ELSE 'zh-CN'
      END),
    COALESCE(preference.theme_mode,'system'),
    COALESCE(preference.theme_palette,'classic'),
    COALESCE(preference.updated_at,now_input)
  FROM actor
  LEFT JOIN user_app_preferences AS preference
    ON preference.user_id=actor.user_id AND preference.app_audience=actor.app_audience
$function$;

CREATE OR REPLACE FUNCTION user_app_preference_upsert(
  session_token_hash_input text,
  locale_input text,
  theme_mode_input text,
  theme_palette_input text,
  now_input timestamptz
)
RETURNS TABLE(
  user_id text,
  app_audience text,
  locale text,
  theme_mode text,
  theme_palette text,
  updated_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  actor_user_id text;
  actor_audience text;
BEGIN
  SELECT account.id,session.app_audience
    INTO actor_user_id,actor_audience
    FROM sessions AS session
    JOIN users AS account ON account.id=session.user_id
   WHERE session.token_hash=session_token_hash_input
     AND session.revoked_at IS NULL
     AND session.expires_at::timestamptz>now_input
     AND session.idle_expires_at>now_input
     AND session.absolute_expires_at>now_input
     AND account.status='active';
  IF actor_user_id IS NULL THEN
    RAISE EXCEPTION 'PREFERENCE_SESSION_INVALID' USING ERRCODE='28000';
  END IF;

  INSERT INTO user_app_preferences(
    user_id,app_audience,locale,theme_mode,theme_palette,created_at,updated_at
  ) VALUES(
    actor_user_id,actor_audience,locale_input,theme_mode_input,theme_palette_input,now_input,now_input
  )
  ON CONFLICT ON CONSTRAINT user_app_preferences_pkey DO UPDATE
    SET locale=EXCLUDED.locale,
        theme_mode=EXCLUDED.theme_mode,
        theme_palette=EXCLUDED.theme_palette,
        updated_at=EXCLUDED.updated_at;

  RETURN QUERY
  SELECT preference.user_id,preference.app_audience,preference.locale,
    preference.theme_mode,preference.theme_palette,preference.updated_at
  FROM user_app_preferences AS preference
  WHERE preference.user_id=actor_user_id AND preference.app_audience=actor_audience;
END
$function$;

REVOKE ALL ON TABLE user_app_preferences FROM PUBLIC;
REVOKE ALL ON FUNCTION user_app_preference_read(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION user_app_preference_upsert(text,text,text,text,timestamptz) FROM PUBLIC;

DO $preference_gateway_grants$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['agentnovas_client_web','agentnovas_ops_web','agentnovas_maint_web'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION user_app_preference_read(text,timestamptz) TO %I',role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION user_app_preference_upsert(text,text,text,text,timestamptz) TO %I',role_name);
    END IF;
  END LOOP;
END
$preference_gateway_grants$;
