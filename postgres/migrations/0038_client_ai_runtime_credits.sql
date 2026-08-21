CREATE OR REPLACE VIEW client_ai_runtime_model_bindings
WITH (security_barrier = true)
AS
SELECT
  binding.role,
  profile.id AS profile_id,
  revision.id AS revision_id,
  revision.provider_name,
  revision.base_url,
  revision.model_name,
  revision.encrypted_api_key
FROM agent_role_bindings AS binding
JOIN llm_profiles AS profile
  ON profile.id = binding.llm_profile_id
JOIN llm_profile_revisions AS revision
  ON revision.id = profile.current_revision_id
WHERE binding.role IN ('report','proposal_a')
  AND binding.enabled = true
  AND profile.enabled = true
  AND revision.enabled = true
  AND revision.encrypted_api_key <> '';

COMMENT ON VIEW client_ai_runtime_model_bindings IS
  'Encrypted, least-privilege runtime projection for paid Client AI routes only.';

CREATE TABLE IF NOT EXISTS client_ai_inference_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('assistant_message','strategy_generation')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  profile_revision_id text NOT NULL REFERENCES llm_profile_revisions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','succeeded','failed')),
  reservation_id text REFERENCES ai_credit_reservations(id) ON DELETE RESTRICT,
  result_json jsonb,
  error_code text,
  error_message text,
  error_status integer CHECK (error_status IS NULL OR error_status BETWEEN 400 AND 599),
  provider_request_id text CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 200
  ),
  usage_id text CHECK (usage_id IS NULL OR length(usage_id) BETWEEN 1 AND 200),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens > 0),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, operation, idempotency_key),
  CHECK (
    (status = 'processing' AND result_json IS NULL AND error_code IS NULL)
    OR
    (status = 'succeeded' AND result_json IS NOT NULL AND error_code IS NULL
      AND provider_request_id IS NOT NULL AND usage_id IS NOT NULL
      AND provider_request_id = usage_id
      AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
      AND completed_at IS NOT NULL)
    OR
    (status = 'failed' AND result_json IS NULL AND error_code IS NOT NULL
      AND error_message IS NOT NULL AND error_status IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_ai_inference_provider_request
  ON client_ai_inference_requests(profile_revision_id, provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_client_ai_inference_requests_user_created
  ON client_ai_inference_requests(user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ai_credit_reservations_stale_runtime
  ON ai_credit_reservations(expires_at, id)
  WHERE status = 'reserved';

REVOKE ALL ON client_ai_runtime_model_bindings FROM PUBLIC;
REVOKE ALL ON client_ai_inference_requests FROM PUBLIC;
