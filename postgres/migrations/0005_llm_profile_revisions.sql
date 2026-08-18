ALTER TABLE llm_profiles
  ADD COLUMN IF NOT EXISTS current_revision_id text;

CREATE TABLE IF NOT EXISTS llm_profile_revisions (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  name text NOT NULL,
  provider_name text NOT NULL,
  base_url text NOT NULL,
  model_name text NOT NULL,
  encrypted_api_key text NOT NULL,
  masked_api_key text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_llm_profile_revisions_profile
  ON llm_profile_revisions (profile_id, revision_number DESC);

INSERT INTO llm_profile_revisions (
  id, profile_id, revision_number, name, provider_name, base_url, model_name,
  encrypted_api_key, masked_api_key, enabled, created_by_user_id, created_at
)
SELECT profile.id || ':revision:1', profile.id, 1, profile.name, profile.provider_name,
       profile.base_url, profile.model_name, profile.encrypted_api_key,
       profile.masked_api_key, profile.enabled, profile.updated_by_user_id, profile.updated_at
FROM llm_profiles AS profile
WHERE NOT EXISTS (
  SELECT 1 FROM llm_profile_revisions AS revision WHERE revision.profile_id = profile.id
)
ON CONFLICT DO NOTHING;

UPDATE llm_profiles AS profile
SET current_revision_id = revision.id
FROM llm_profile_revisions AS revision
WHERE revision.profile_id = profile.id
  AND revision.revision_number = (
    SELECT MAX(latest.revision_number)
    FROM llm_profile_revisions AS latest
    WHERE latest.profile_id = profile.id
  )
  AND profile.current_revision_id IS NULL;
