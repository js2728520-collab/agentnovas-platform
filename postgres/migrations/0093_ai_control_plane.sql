-- Reusable AI control plane. Legacy LLM tables remain intact as rollback evidence.

CREATE TABLE IF NOT EXISTS ai_provider_connections (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  adapter_id text NOT NULL DEFAULT 'openai-compatible' CHECK (adapter_id='openai-compatible'),
  current_revision_id text,
  enabled boolean NOT NULL DEFAULT false,
  legacy_profile_id text UNIQUE REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  created_by_user_id text NOT NULL,
  updated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_connection_revisions (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES ai_provider_connections(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[^[:space:]]+$'),
  secret_ref text,
  secret_fingerprint text,
  network_policy text NOT NULL DEFAULT 'public_https' CHECK (network_policy='public_https'),
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[a-f0-9]{64}$'),
  legacy_profile_revision_id text UNIQUE REFERENCES llm_profile_revisions(id) ON DELETE RESTRICT,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id,revision_number),
  CHECK (secret_ref IS NULL OR secret_ref ~ '^managed://[A-Za-z0-9._:/-]+$'),
  CHECK (secret_fingerprint IS NULL OR secret_fingerprint ~ '^[a-f0-9]{12,64}$')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='ai_provider_connections_current_revision_fk'
      AND conrelid='ai_provider_connections'::regclass
  ) THEN
    ALTER TABLE ai_provider_connections
      ADD CONSTRAINT ai_provider_connections_current_revision_fk
      FOREIGN KEY(current_revision_id) REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_connection_revisions_connection
  ON ai_connection_revisions(connection_id,revision_number DESC);

CREATE TABLE IF NOT EXISTS ai_model_deployments (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  current_revision_id text,
  enabled boolean NOT NULL DEFAULT false,
  legacy_profile_id text UNIQUE REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  created_by_user_id text NOT NULL,
  updated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_deployment_revisions (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES ai_model_deployments(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  connection_revision_id text NOT NULL REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  model_id text NOT NULL CHECK (length(btrim(model_id)) BETWEEN 1 AND 200),
  context_window integer CHECK (context_window IS NULL OR context_window > 0),
  max_output_tokens integer CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
  supports_streaming boolean NOT NULL DEFAULT true,
  supports_structured_output boolean NOT NULL DEFAULT false,
  invocation_parameters_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(invocation_parameters_json)='object'),
  capability_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capability_metadata_json)='object'),
  rate_card_revision_id text,
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[a-f0-9]{64}$'),
  legacy_profile_revision_id text UNIQUE REFERENCES llm_profile_revisions(id) ON DELETE RESTRICT,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id,revision_number)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='ai_model_deployments_current_revision_fk'
      AND conrelid='ai_model_deployments'::regclass
  ) THEN
    ALTER TABLE ai_model_deployments
      ADD CONSTRAINT ai_model_deployments_current_revision_fk
      FOREIGN KEY(current_revision_id) REFERENCES ai_deployment_revisions(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_deployment_revisions_deployment
  ON ai_deployment_revisions(deployment_id,revision_number DESC);

CREATE TABLE IF NOT EXISTS ai_control_plane_roles (
  role text PRIMARY KEY CHECK (role IN (
    'requirements','market_regime','proposal_a','proposal_b','adversarial_review','risk_review','report',
    'market_summary','adversarial_explanation','risk_explanation','assistant_message','strategy_generation'
  )),
  consumer text NOT NULL CHECK (consumer IN ('research','runtime_explanation','client_ai')),
  default_runtime_state text NOT NULL CHECK (default_runtime_state IN ('active','gated','disabled','retired')),
  capability_requirements_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capability_requirements_json)='object')
);

INSERT INTO ai_control_plane_roles(role,consumer,default_runtime_state) VALUES
  ('requirements','research','retired'),
  ('market_regime','research','retired'),
  ('proposal_a','research','retired'),
  ('proposal_b','research','retired'),
  ('adversarial_review','research','retired'),
  ('risk_review','research','retired'),
  ('report','research','retired'),
  ('market_summary','runtime_explanation','gated'),
  ('adversarial_explanation','runtime_explanation','gated'),
  ('risk_explanation','runtime_explanation','gated'),
  ('assistant_message','client_ai','gated'),
  ('strategy_generation','client_ai','gated')
ON CONFLICT(role) DO UPDATE SET
  consumer=EXCLUDED.consumer,
  default_runtime_state=EXCLUDED.default_runtime_state;

CREATE TABLE IF NOT EXISTS ai_binding_policies (
  id text PRIMARY KEY,
  role text NOT NULL UNIQUE REFERENCES ai_control_plane_roles(role) ON DELETE RESTRICT,
  current_revision_id text,
  enabled boolean NOT NULL DEFAULT false,
  updated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_binding_policy_revisions (
  id text PRIMARY KEY,
  binding_policy_id text NOT NULL REFERENCES ai_binding_policies(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  capability_requirements_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capability_requirements_json)='object'),
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(binding_policy_id,revision_number)
);

CREATE TABLE IF NOT EXISTS ai_binding_targets (
  binding_policy_revision_id text REFERENCES ai_binding_policy_revisions(id) ON DELETE RESTRICT,
  target_rank integer NOT NULL CHECK (target_rank BETWEEN 0 AND 2),
  deployment_revision_id text NOT NULL REFERENCES ai_deployment_revisions(id) ON DELETE RESTRICT,
  PRIMARY KEY(binding_policy_revision_id,target_rank),
  UNIQUE(binding_policy_revision_id,deployment_revision_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='ai_binding_policies_current_revision_fk'
      AND conrelid='ai_binding_policies'::regclass
  ) THEN
    ALTER TABLE ai_binding_policies
      ADD CONSTRAINT ai_binding_policies_current_revision_fk
      FOREIGN KEY(current_revision_id) REFERENCES ai_binding_policy_revisions(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_probe_receipts (
  id text PRIMARY KEY,
  connection_revision_id text NOT NULL REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  deployment_revision_id text REFERENCES ai_deployment_revisions(id) ON DELETE RESTRICT,
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL CHECK (phase IN ('endpoint','authentication','model_discovery','invocation')),
  status text NOT NULL CHECK (status IN ('requested','processing','succeeded','failed','cancelled')),
  error_class text CHECK (error_class IS NULL OR error_class IN (
    'network','timeout','rate_limited','provider_5xx','authentication','configuration','validation','budget','permission','cancelled','output_contract'
  )),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  discovered_model_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(discovered_model_ids_json)='array'),
  requested_by_user_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status IN ('succeeded','failed','cancelled'))=(completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ai_probe_receipts_fingerprint
  ON ai_probe_receipts(config_fingerprint,completed_at DESC);

CREATE TABLE IF NOT EXISTS ai_invocation_receipts (
  invocation_id text PRIMARY KEY,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  binding_policy_revision_id text REFERENCES ai_binding_policy_revisions(id) ON DELETE RESTRICT,
  selected_deployment_revision_id text REFERENCES ai_deployment_revisions(id) ON DELETE RESTRICT,
  selected_connection_revision_id text REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  role text REFERENCES ai_control_plane_roles(role) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (length(btrim(operation)) BETWEEN 1 AND 120),
  traffic_kind text NOT NULL CHECK (traffic_kind IN ('business','probe')),
  status text NOT NULL CHECK (status IN ('requested','processing','succeeded','failed','cancelled')),
  fallback_trace_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fallback_trace_json)='array'),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  queue_latency_ms integer CHECK (queue_latency_ms IS NULL OR queue_latency_ms >= 0),
  provider_latency_ms integer CHECK (provider_latency_ms IS NULL OR provider_latency_ms >= 0),
  total_latency_ms integer CHECK (total_latency_ms IS NULL OR total_latency_ms >= 0),
  provider_request_id_hash text,
  response_content text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_class text CHECK (error_class IS NULL OR error_class IN (
    'network','timeout','rate_limited','provider_5xx','authentication','configuration','validation','budget','permission','cancelled','output_contract'
  )),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('succeeded','failed','cancelled'))=(completed_at IS NOT NULL)),
  CHECK (
    (traffic_kind='business' AND binding_policy_revision_id IS NOT NULL AND role IS NOT NULL)
    OR (traffic_kind='probe' AND binding_policy_revision_id IS NULL AND role IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id text PRIMARY KEY,
  invocation_id text NOT NULL REFERENCES ai_invocation_receipts(invocation_id) ON DELETE RESTRICT,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  event_kind text NOT NULL CHECK (event_kind IN ('requested','attempted','succeeded','failed','cancelled','processing')),
  consumer text NOT NULL CHECK (consumer IN ('research','runtime_explanation','client_ai','probe')),
  role text REFERENCES ai_control_plane_roles(role) ON DELETE RESTRICT,
  deployment_revision_id text REFERENCES ai_deployment_revisions(id) ON DELETE RESTRICT,
  connection_revision_id text REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  fallback_rank integer CHECK (fallback_rank IS NULL OR fallback_rank BETWEEN 0 AND 2),
  pseudonymized_user_id text,
  organization_id text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  queue_latency_ms integer CHECK (queue_latency_ms IS NULL OR queue_latency_ms >= 0),
  provider_latency_ms integer CHECK (provider_latency_ms IS NULL OR provider_latency_ms >= 0),
  total_latency_ms integer CHECK (total_latency_ms IS NULL OR total_latency_ms >= 0),
  provider_cost_amount numeric(30,12),
  provider_cost_currency text,
  platform_settled_credits bigint,
  pricing_state text NOT NULL DEFAULT 'unpriced' CHECK (pricing_state IN ('priced','unpriced')),
  error_class text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invocation_id,event_sequence),
  CHECK ((provider_cost_amount IS NULL)=(provider_cost_currency IS NULL)),
  CHECK (provider_cost_amount IS NULL OR provider_cost_amount >= 0),
  CHECK (platform_settled_credits IS NULL OR platform_settled_credits >= 0),
  CHECK ((pricing_state='unpriced' AND provider_cost_amount IS NULL) OR pricing_state='priced')
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_reporting
  ON ai_usage_events(occurred_at DESC,consumer,role);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_invocation
  ON ai_usage_events(invocation_id,event_sequence);

CREATE TABLE IF NOT EXISTS ai_rate_card_revisions (
  id text PRIMARY KEY,
  deployment_id text NOT NULL REFERENCES ai_model_deployments(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  currency text NOT NULL CHECK (length(currency) BETWEEN 3 AND 8),
  input_cost_per_million numeric(30,12) NOT NULL CHECK (input_cost_per_million >= 0),
  output_cost_per_million numeric(30,12) NOT NULL CHECK (output_cost_per_million >= 0),
  cached_input_cost_per_million numeric(30,12) CHECK (cached_input_cost_per_million IS NULL OR cached_input_cost_per_million >= 0),
  effective_from timestamptz NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(deployment_id,revision_number)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='ai_deployment_revisions_rate_card_fk'
      AND conrelid='ai_deployment_revisions'::regclass
  ) THEN
    ALTER TABLE ai_deployment_revisions
      ADD CONSTRAINT ai_deployment_revisions_rate_card_fk
      FOREIGN KEY(rate_card_revision_id) REFERENCES ai_rate_card_revisions(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_budget_policies (
  id text PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform','organization','consumer','role','deployment')),
  scope_key text NOT NULL,
  period text NOT NULL CHECK (period IN ('day','month')),
  limit_amount numeric(38,12) NOT NULL CHECK (limit_amount > 0),
  unit text NOT NULL CHECK (unit IN ('requests','provider_cost','platform_credits','tokens')),
  warning_threshold_percent integer NOT NULL DEFAULT 80 CHECK (warning_threshold_percent BETWEEN 1 AND 99),
  exceeded_threshold_percent integer NOT NULL DEFAULT 100 CHECK (exceeded_threshold_percent=100),
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(scope_kind,scope_key,period,unit)
);

CREATE TABLE IF NOT EXISTS ai_budget_alerts (
  id text PRIMARY KEY,
  budget_policy_id text NOT NULL REFERENCES ai_budget_policies(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  threshold_percent integer NOT NULL CHECK (threshold_percent BETWEEN 1 AND 100),
  observed_amount numeric(38,12) NOT NULL CHECK (observed_amount >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by_user_id text,
  acknowledged_at timestamptz,
  UNIQUE(budget_policy_id,period_start,threshold_percent)
);

-- One legacy profile becomes one connection and one deployment. Existing profile and
-- revision IDs are retained by deployments so historical run references keep working.
INSERT INTO ai_provider_connections(
  id,name,adapter_id,enabled,legacy_profile_id,created_by_user_id,updated_by_user_id,created_at,updated_at
)
SELECT
  'legacy-connection:' || profile.id,
  profile.provider_name,
  'openai-compatible',
  false,
  profile.id,
  profile.created_by_user_id,
  profile.updated_by_user_id,
  profile.created_at,
  profile.updated_at
FROM llm_profiles AS profile
ON CONFLICT(legacy_profile_id) DO NOTHING;

INSERT INTO ai_connection_revisions(
  id,connection_id,revision_number,endpoint,secret_ref,secret_fingerprint,network_policy,
  config_fingerprint,legacy_profile_revision_id,created_by_user_id,created_at
)
SELECT
  'legacy-connection-revision:' || revision.id,
  connection.id,
  revision.revision_number,
  revision.base_url,
  NULL,
  md5(revision.encrypted_api_key),
  'public_https',
  md5(revision.provider_name || E'\n' || revision.base_url) || md5('v2:' || revision.provider_name || E'\n' || revision.base_url),
  revision.id,
  revision.created_by_user_id,
  revision.created_at
FROM llm_profile_revisions AS revision
JOIN ai_provider_connections AS connection ON connection.legacy_profile_id=revision.profile_id
ON CONFLICT(legacy_profile_revision_id) DO NOTHING;

UPDATE ai_provider_connections AS connection
SET current_revision_id=connection_revision.id
FROM llm_profiles AS profile
JOIN ai_connection_revisions AS connection_revision
  ON connection_revision.legacy_profile_revision_id=profile.current_revision_id
WHERE connection.legacy_profile_id=profile.id
  AND connection.current_revision_id IS DISTINCT FROM connection_revision.id;

INSERT INTO ai_model_deployments(
  id,name,enabled,legacy_profile_id,created_by_user_id,updated_by_user_id,created_at,updated_at
)
SELECT
  profile.id,profile.name,false,profile.id,profile.created_by_user_id,profile.updated_by_user_id,profile.created_at,profile.updated_at
FROM llm_profiles AS profile
ON CONFLICT(legacy_profile_id) DO NOTHING;

INSERT INTO ai_deployment_revisions(
  id,deployment_id,revision_number,connection_revision_id,model_id,config_fingerprint,
  legacy_profile_revision_id,created_by_user_id,created_at
)
SELECT
  revision.id,
  deployment.id,
  revision.revision_number,
  connection_revision.id,
  revision.model_name,
  md5(connection_revision.config_fingerprint || E'\n' || revision.model_name) || md5('v2:' || connection_revision.config_fingerprint || E'\n' || revision.model_name),
  revision.id,
  revision.created_by_user_id,
  revision.created_at
FROM llm_profile_revisions AS revision
JOIN ai_model_deployments AS deployment ON deployment.legacy_profile_id=revision.profile_id
JOIN ai_connection_revisions AS connection_revision ON connection_revision.legacy_profile_revision_id=revision.id
ON CONFLICT(legacy_profile_revision_id) DO NOTHING;

UPDATE ai_model_deployments AS deployment
SET current_revision_id=profile.current_revision_id
FROM llm_profiles AS profile
WHERE deployment.legacy_profile_id=profile.id
  AND deployment.current_revision_id IS DISTINCT FROM profile.current_revision_id;

INSERT INTO ai_binding_policies(id,role,enabled,updated_by_user_id)
SELECT 'binding:' || role.role,role.role,false,'migration-0093'
FROM ai_control_plane_roles AS role
ON CONFLICT(role) DO NOTHING;

WITH legacy_bindings AS (
  SELECT binding.role,binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM agent_role_bindings AS binding
  UNION ALL
  SELECT binding.role,binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM runtime_explanation_bindings AS binding
  UNION ALL
  SELECT 'assistant_message',binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM agent_role_bindings AS binding WHERE binding.role='report'
  UNION ALL
  SELECT 'strategy_generation',binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM agent_role_bindings AS binding WHERE binding.role='proposal_a'
), candidates AS (
  SELECT legacy.role,legacy.enabled,legacy.updated_by_user_id,profile.current_revision_id,
    row_number() OVER (PARTITION BY legacy.role ORDER BY legacy.llm_profile_id) AS candidate_rank
  FROM legacy_bindings AS legacy
  JOIN llm_profiles AS profile ON profile.id=legacy.llm_profile_id
  WHERE profile.current_revision_id IS NOT NULL
)
INSERT INTO ai_binding_policy_revisions(
  id,binding_policy_id,revision_number,capability_requirements_json,config_fingerprint,created_by_user_id
)
SELECT
  'binding-revision:' || candidate.role || ':1',
  policy.id,
  1,
  '{}'::jsonb,
  md5(candidate.role || E'\n' || candidate.current_revision_id) || md5('v2:' || candidate.role || E'\n' || candidate.current_revision_id),
  candidate.updated_by_user_id
FROM candidates AS candidate
JOIN ai_binding_policies AS policy ON policy.role=candidate.role
WHERE candidate.candidate_rank=1
ON CONFLICT(binding_policy_id,revision_number) DO NOTHING;

WITH legacy_bindings AS (
  SELECT binding.role,binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM agent_role_bindings AS binding
  UNION ALL
  SELECT binding.role,binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM runtime_explanation_bindings AS binding
  UNION ALL
  SELECT 'assistant_message',binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM agent_role_bindings AS binding WHERE binding.role='report'
  UNION ALL
  SELECT 'strategy_generation',binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
  FROM agent_role_bindings AS binding WHERE binding.role='proposal_a'
), candidates AS (
  SELECT legacy.role,legacy.enabled,profile.current_revision_id,
    row_number() OVER (PARTITION BY legacy.role ORDER BY legacy.llm_profile_id) AS candidate_rank
  FROM legacy_bindings AS legacy
  JOIN llm_profiles AS profile ON profile.id=legacy.llm_profile_id
  WHERE profile.current_revision_id IS NOT NULL
)
INSERT INTO ai_binding_targets(binding_policy_revision_id,target_rank,deployment_revision_id)
SELECT revision.id,0,candidate.current_revision_id
FROM candidates AS candidate
JOIN ai_binding_policies AS policy ON policy.role=candidate.role
JOIN ai_binding_policy_revisions AS revision ON revision.binding_policy_id=policy.id AND revision.revision_number=1
WHERE candidate.candidate_rank=1
ON CONFLICT(binding_policy_revision_id,target_rank) DO NOTHING;

WITH legacy_bindings AS (
  SELECT binding.role,binding.enabled,binding.updated_by_user_id FROM agent_role_bindings AS binding
  UNION ALL
  SELECT binding.role,binding.enabled,binding.updated_by_user_id FROM runtime_explanation_bindings AS binding
  UNION ALL
  SELECT 'assistant_message',binding.enabled,binding.updated_by_user_id FROM agent_role_bindings AS binding WHERE binding.role='report'
  UNION ALL
  SELECT 'strategy_generation',binding.enabled,binding.updated_by_user_id FROM agent_role_bindings AS binding WHERE binding.role='proposal_a'
), candidates AS (
  SELECT legacy.*,row_number() OVER (PARTITION BY legacy.role ORDER BY legacy.updated_by_user_id) AS candidate_rank
  FROM legacy_bindings AS legacy
)
UPDATE ai_binding_policies AS policy
SET
  current_revision_id=revision.id,
  enabled=candidate.enabled,
  updated_by_user_id=candidate.updated_by_user_id,
  updated_at=now()
FROM candidates AS candidate
JOIN ai_binding_policy_revisions AS revision
  ON revision.binding_policy_id='binding:' || candidate.role AND revision.revision_number=1
WHERE policy.role=candidate.role AND candidate.candidate_rank=1;

CREATE OR REPLACE FUNCTION ai_sync_legacy_profile(p_profile_id text)
RETURNS boolean AS $$
DECLARE
  profile_exists boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM llm_profiles WHERE id=p_profile_id) INTO profile_exists;
  IF NOT profile_exists THEN RETURN false; END IF;

  INSERT INTO ai_provider_connections(
    id,name,adapter_id,enabled,legacy_profile_id,created_by_user_id,updated_by_user_id,created_at,updated_at
  )
  SELECT 'legacy-connection:' || profile.id,profile.provider_name,'openai-compatible',false,
         profile.id,profile.created_by_user_id,profile.updated_by_user_id,profile.created_at,profile.updated_at
  FROM llm_profiles AS profile WHERE profile.id=p_profile_id
  ON CONFLICT(legacy_profile_id) DO UPDATE SET
    name=EXCLUDED.name,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at;

  INSERT INTO ai_connection_revisions(
    id,connection_id,revision_number,endpoint,secret_ref,secret_fingerprint,network_policy,
    config_fingerprint,legacy_profile_revision_id,created_by_user_id,created_at
  )
  SELECT 'legacy-connection-revision:' || revision.id,connection.id,revision.revision_number,
         revision.base_url,NULL,md5(revision.encrypted_api_key),'public_https',
         md5(revision.provider_name || E'\n' || revision.base_url)
           || md5('v2:' || revision.provider_name || E'\n' || revision.base_url),
         revision.id,revision.created_by_user_id,revision.created_at
  FROM llm_profile_revisions AS revision
  JOIN ai_provider_connections AS connection ON connection.legacy_profile_id=revision.profile_id
  WHERE revision.profile_id=p_profile_id
  ON CONFLICT(legacy_profile_revision_id) DO NOTHING;

  INSERT INTO ai_model_deployments(
    id,name,enabled,legacy_profile_id,created_by_user_id,updated_by_user_id,created_at,updated_at
  )
  SELECT profile.id,profile.name,false,profile.id,profile.created_by_user_id,
         profile.updated_by_user_id,profile.created_at,profile.updated_at
  FROM llm_profiles AS profile WHERE profile.id=p_profile_id
  ON CONFLICT(legacy_profile_id) DO UPDATE SET
    name=EXCLUDED.name,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at;

  INSERT INTO ai_deployment_revisions(
    id,deployment_id,revision_number,connection_revision_id,model_id,config_fingerprint,
    legacy_profile_revision_id,created_by_user_id,created_at
  )
  SELECT revision.id,deployment.id,revision.revision_number,connection_revision.id,revision.model_name,
         md5(connection_revision.config_fingerprint || E'\n' || revision.model_name)
           || md5('v2:' || connection_revision.config_fingerprint || E'\n' || revision.model_name),
         revision.id,revision.created_by_user_id,revision.created_at
  FROM llm_profile_revisions AS revision
  JOIN ai_model_deployments AS deployment ON deployment.legacy_profile_id=revision.profile_id
  JOIN ai_connection_revisions AS connection_revision ON connection_revision.legacy_profile_revision_id=revision.id
  WHERE revision.profile_id=p_profile_id
  ON CONFLICT(legacy_profile_revision_id) DO NOTHING;

  UPDATE ai_provider_connections AS connection
  SET current_revision_id=connection_revision.id
  FROM llm_profiles AS profile
  JOIN ai_connection_revisions AS connection_revision
    ON connection_revision.legacy_profile_revision_id=profile.current_revision_id
  WHERE profile.id=p_profile_id AND connection.legacy_profile_id=profile.id;

  UPDATE ai_model_deployments AS deployment
  SET current_revision_id=profile.current_revision_id
  FROM llm_profiles AS profile
  WHERE profile.id=p_profile_id AND deployment.legacy_profile_id=profile.id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_evaluate_budget_alerts(p_occurred_at timestamptz)
RETURNS integer AS $$
DECLARE
  policy ai_budget_policies%ROWTYPE;
  period_start_value timestamptz;
  period_end_value timestamptz;
  observed numeric(38,12);
  currency_count integer;
  inserted_count integer := 0;
BEGIN
  FOR policy IN SELECT * FROM ai_budget_policies WHERE enabled LOOP
    IF policy.period='day' THEN
      period_start_value := date_trunc('day',p_occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      period_end_value := period_start_value + interval '1 day';
    ELSE
      period_start_value := date_trunc('month',p_occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      period_end_value := period_start_value + interval '1 month';
    END IF;
    SELECT
      CASE policy.unit
        WHEN 'requests' THEN count(*) FILTER (WHERE event.event_kind='requested')::numeric
        WHEN 'tokens' THEN COALESCE(sum(
          event.input_tokens+event.output_tokens+event.cached_input_tokens+event.reasoning_tokens
        ),0)::numeric
        WHEN 'platform_credits' THEN COALESCE(sum(event.platform_settled_credits),0)::numeric
        WHEN 'provider_cost' THEN COALESCE(sum(event.provider_cost_amount),0)::numeric
      END,
      count(DISTINCT event.provider_cost_currency) FILTER (WHERE event.provider_cost_currency IS NOT NULL)
    INTO observed,currency_count
    FROM ai_usage_events AS event
    LEFT JOIN ai_deployment_revisions AS revision ON revision.id=event.deployment_revision_id
    WHERE event.occurred_at>=period_start_value AND event.occurred_at<period_end_value
      AND CASE policy.scope_kind
        WHEN 'platform' THEN true
        WHEN 'organization' THEN event.organization_id=policy.scope_key
        WHEN 'consumer' THEN event.consumer=policy.scope_key
        WHEN 'role' THEN event.role=policy.scope_key OR policy.scope_key LIKE '%.' || event.role
        WHEN 'deployment' THEN event.deployment_revision_id=policy.scope_key OR revision.deployment_id=policy.scope_key
        ELSE false
      END;
    IF policy.unit='provider_cost' AND currency_count>1 THEN CONTINUE; END IF;
    IF observed*100 >= policy.limit_amount*policy.warning_threshold_percent THEN
      INSERT INTO ai_budget_alerts(id,budget_policy_id,period_start,threshold_percent,observed_amount)
      VALUES(
        'ai-budget-alert-' || md5(policy.id || period_start_value::text || policy.warning_threshold_percent::text),
        policy.id,period_start_value,policy.warning_threshold_percent,observed
      ) ON CONFLICT(budget_policy_id,period_start,threshold_percent) DO UPDATE SET
        observed_amount=GREATEST(ai_budget_alerts.observed_amount,EXCLUDED.observed_amount);
      inserted_count := inserted_count + 1;
    END IF;
    IF observed>=policy.limit_amount THEN
      INSERT INTO ai_budget_alerts(id,budget_policy_id,period_start,threshold_percent,observed_amount)
      VALUES(
        'ai-budget-alert-' || md5(policy.id || period_start_value::text || '100'),
        policy.id,period_start_value,100,observed
      ) ON CONFLICT(budget_policy_id,period_start,threshold_percent) DO UPDATE SET
        observed_amount=GREATEST(ai_budget_alerts.observed_amount,EXCLUDED.observed_amount);
      inserted_count := inserted_count + 1;
    END IF;
  END LOOP;
  RETURN inserted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_sync_legacy_binding(p_role text,p_revision_id text)
RETURNS boolean AS $$
DECLARE
  source_row record;
  policy_row record;
  next_revision integer;
BEGIN
  IF p_role NOT IN (
    'requirements','market_regime','proposal_a','proposal_b','adversarial_review','risk_review','report',
    'market_summary','adversarial_explanation','risk_explanation','assistant_message','strategy_generation'
  ) THEN RAISE EXCEPTION 'AI_BINDING_ROLE_INVALID' USING ERRCODE='22023'; END IF;
  IF p_revision_id IS NULL OR length(btrim(p_revision_id)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'AI_BINDING_REVISION_ID_INVALID' USING ERRCODE='22023';
  END IF;

  SELECT source.* INTO source_row
  FROM (
    SELECT binding.role,binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
    FROM agent_role_bindings AS binding
    WHERE binding.role=CASE p_role WHEN 'assistant_message' THEN 'report' WHEN 'strategy_generation' THEN 'proposal_a' ELSE p_role END
      AND p_role NOT IN ('market_summary','adversarial_explanation','risk_explanation')
    UNION ALL
    SELECT binding.role,binding.llm_profile_id,binding.enabled,binding.updated_by_user_id
    FROM runtime_explanation_bindings AS binding
    WHERE binding.role=p_role AND p_role IN ('market_summary','adversarial_explanation','risk_explanation')
  ) AS source
  LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM ai_sync_legacy_profile(source_row.llm_profile_id);
  SELECT id INTO policy_row FROM ai_binding_policies WHERE role=p_role FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT COALESCE(MAX(revision_number),0) + 1 INTO next_revision
  FROM ai_binding_policy_revisions WHERE binding_policy_id=policy_row.id;

  INSERT INTO ai_binding_policy_revisions(
    id,binding_policy_id,revision_number,capability_requirements_json,config_fingerprint,created_by_user_id
  ) VALUES(
    p_revision_id,policy_row.id,next_revision,'{}'::jsonb,
    md5(p_role || E'\n' || (SELECT current_revision_id FROM llm_profiles WHERE id=source_row.llm_profile_id))
      || md5('v2:' || p_role || E'\n' || (SELECT current_revision_id FROM llm_profiles WHERE id=source_row.llm_profile_id)),
    source_row.updated_by_user_id
  );
  INSERT INTO ai_binding_targets(binding_policy_revision_id,target_rank,deployment_revision_id)
  SELECT p_revision_id,0,current_revision_id FROM llm_profiles WHERE id=source_row.llm_profile_id;
  UPDATE ai_binding_policies
  SET current_revision_id=p_revision_id,enabled=source_row.enabled,
      updated_by_user_id=source_row.updated_by_user_id,updated_at=now()
  WHERE id=policy_row.id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION ai_sync_legacy_profile(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_sync_legacy_binding(text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ai_save_connection_deployment(
  p_connection_id text,
  p_connection_revision_id text,
  p_connection_name text,
  p_endpoint text,
  p_deployment_id text,
  p_deployment_revision_id text,
  p_deployment_name text,
  p_model_id text,
  p_context_window integer,
  p_max_output_tokens integer,
  p_supports_streaming boolean,
  p_supports_structured_output boolean,
  p_actor_user_id text,
  p_reason text,
  p_request_id text
) RETURNS jsonb AS $$
DECLARE
  previous_connection_revision ai_connection_revisions%ROWTYPE;
  connection_revision_number integer;
  deployment_revision_number integer;
  connection_fingerprint text;
  deployment_fingerprint text;
BEGIN
  IF length(btrim(p_connection_name)) NOT BETWEEN 1 AND 120
    OR length(btrim(p_deployment_name)) NOT BETWEEN 1 AND 120
    OR length(btrim(p_model_id)) NOT BETWEEN 1 AND 200
    OR p_endpoint !~ '^https://[^[:space:]]+$'
    OR p_context_window IS NOT NULL AND p_context_window <= 0
    OR p_max_output_tokens IS NOT NULL AND p_max_output_tokens <= 0
    OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'AI_CONFIGURATION_INVALID' USING ERRCODE='22023'; END IF;

  INSERT INTO ai_provider_connections(
    id,name,adapter_id,enabled,created_by_user_id,updated_by_user_id
  ) VALUES(
    p_connection_id,btrim(p_connection_name),'openai-compatible',false,p_actor_user_id,p_actor_user_id
  ) ON CONFLICT(id) DO UPDATE SET
    name=EXCLUDED.name,enabled=false,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now();
  PERFORM 1 FROM ai_provider_connections WHERE id=p_connection_id FOR UPDATE;
  SELECT revision.* INTO previous_connection_revision
  FROM ai_provider_connections AS connection
  LEFT JOIN ai_connection_revisions AS revision ON revision.id=connection.current_revision_id
  WHERE connection.id=p_connection_id;
  SELECT COALESCE(MAX(revision_number),0)+1 INTO connection_revision_number
  FROM ai_connection_revisions WHERE connection_id=p_connection_id;
  connection_fingerprint := md5(p_endpoint || E'\n' || COALESCE(previous_connection_revision.secret_fingerprint,''))
    || md5('v2:' || p_endpoint || E'\n' || COALESCE(previous_connection_revision.secret_fingerprint,''));
  INSERT INTO ai_connection_revisions(
    id,connection_id,revision_number,endpoint,secret_ref,secret_fingerprint,network_policy,
    config_fingerprint,created_by_user_id
  ) VALUES(
    p_connection_revision_id,p_connection_id,connection_revision_number,p_endpoint,
    previous_connection_revision.secret_ref,previous_connection_revision.secret_fingerprint,
    'public_https',connection_fingerprint,p_actor_user_id
  );
  UPDATE ai_provider_connections SET current_revision_id=p_connection_revision_id WHERE id=p_connection_id;

  INSERT INTO ai_model_deployments(
    id,name,enabled,created_by_user_id,updated_by_user_id
  ) VALUES(
    p_deployment_id,btrim(p_deployment_name),false,p_actor_user_id,p_actor_user_id
  ) ON CONFLICT(id) DO UPDATE SET
    name=EXCLUDED.name,enabled=false,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now();
  PERFORM 1 FROM ai_model_deployments WHERE id=p_deployment_id FOR UPDATE;
  SELECT COALESCE(MAX(revision_number),0)+1 INTO deployment_revision_number
  FROM ai_deployment_revisions WHERE deployment_id=p_deployment_id;
  deployment_fingerprint := md5(connection_fingerprint || E'\n' || p_model_id || E'\n'
    || COALESCE(p_context_window::text,'') || E'\n' || COALESCE(p_max_output_tokens::text,'')
    || E'\n' || p_supports_streaming::text || E'\n' || p_supports_structured_output::text)
    || md5('v2:' || connection_fingerprint || E'\n' || p_model_id || E'\n'
    || COALESCE(p_context_window::text,'') || E'\n' || COALESCE(p_max_output_tokens::text,'')
    || E'\n' || p_supports_streaming::text || E'\n' || p_supports_structured_output::text);
  INSERT INTO ai_deployment_revisions(
    id,deployment_id,revision_number,connection_revision_id,model_id,context_window,max_output_tokens,
    supports_streaming,supports_structured_output,config_fingerprint,created_by_user_id
  ) VALUES(
    p_deployment_revision_id,p_deployment_id,deployment_revision_number,p_connection_revision_id,
    btrim(p_model_id),p_context_window,p_max_output_tokens,p_supports_streaming,
    p_supports_structured_output,deployment_fingerprint,p_actor_user_id
  );
  UPDATE ai_model_deployments SET current_revision_id=p_deployment_revision_id WHERE id=p_deployment_id;

  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(
    'ai-control-plane-config-' || md5(p_request_id || p_deployment_revision_id),p_actor_user_id,
    'maintenance.ai_control_plane.configuration_saved','ai_model_deployment',p_deployment_id,
    jsonb_build_object(
      'reason',btrim(p_reason),'connectionId',p_connection_id,
      'connectionRevisionId',p_connection_revision_id,'deploymentRevisionId',p_deployment_revision_id
    )::text,p_request_id
  ) ON CONFLICT(id) DO NOTHING;
  RETURN jsonb_build_object(
    'connectionId',p_connection_id,'connectionRevisionId',p_connection_revision_id,
    'deploymentId',p_deployment_id,'deploymentRevisionId',p_deployment_revision_id,
    'configurationFingerprint',deployment_fingerprint
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_update_binding_policy(
  p_role text,
  p_revision_id text,
  p_deployment_revision_ids text[],
  p_enabled boolean,
  p_actor_user_id text,
  p_reason text,
  p_request_id text
) RETURNS text AS $$
DECLARE
  policy_row ai_binding_policies%ROWTYPE;
  next_revision integer;
  configuration_fingerprint text;
  deployment_revision_id text;
BEGIN
  SELECT * INTO policy_row FROM ai_binding_policies WHERE role=p_role FOR UPDATE;
  IF NOT FOUND OR cardinality(p_deployment_revision_ids) NOT BETWEEN 1 AND 3
    OR (SELECT count(DISTINCT value) FROM unnest(p_deployment_revision_ids) AS value) <> cardinality(p_deployment_revision_ids)
    OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'AI_BINDING_INVALID' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM ai_deployment_revisions WHERE id=ANY(p_deployment_revision_ids))
    <> cardinality(p_deployment_revision_ids)
  THEN RAISE EXCEPTION 'AI_BINDING_DEPLOYMENT_MISSING' USING ERRCODE='23503'; END IF;
  IF p_enabled AND EXISTS(
    SELECT 1
    FROM ai_deployment_revisions AS deployment
    JOIN ai_connection_revisions AS connection ON connection.id=deployment.connection_revision_id
    WHERE deployment.id=ANY(p_deployment_revision_ids)
      AND (
        connection.secret_ref IS NULL
        OR NOT EXISTS(
          SELECT 1 FROM LATERAL (
            SELECT receipt.status,receipt.completed_at
            FROM ai_probe_receipts AS receipt
            WHERE receipt.deployment_revision_id=deployment.id
              AND receipt.config_fingerprint=deployment.config_fingerprint
            ORDER BY receipt.requested_at DESC,receipt.id DESC
            LIMIT 1
          ) AS probe
          WHERE probe.status='succeeded'
            AND probe.completed_at>=now()-interval '24 hours'
        )
      )
  ) THEN RAISE EXCEPTION 'AI_BINDING_PROBE_REQUIRED' USING ERRCODE='23514'; END IF;

  SELECT COALESCE(MAX(revision_number),0)+1 INTO next_revision
  FROM ai_binding_policy_revisions WHERE binding_policy_id=policy_row.id;
  configuration_fingerprint := md5(p_role || E'\n' || array_to_string(p_deployment_revision_ids,E'\n'))
    || md5('v2:' || p_role || E'\n' || array_to_string(p_deployment_revision_ids,E'\n'));
  INSERT INTO ai_binding_policy_revisions(
    id,binding_policy_id,revision_number,config_fingerprint,created_by_user_id
  ) VALUES(p_revision_id,policy_row.id,next_revision,configuration_fingerprint,p_actor_user_id);
  INSERT INTO ai_binding_targets(binding_policy_revision_id,target_rank,deployment_revision_id)
  SELECT p_revision_id,ordinality-1,value
  FROM unnest(p_deployment_revision_ids) WITH ORDINALITY AS target(value,ordinality);
  UPDATE ai_binding_policies SET
    current_revision_id=p_revision_id,enabled=p_enabled,updated_by_user_id=p_actor_user_id,updated_at=now()
  WHERE id=policy_row.id;
  IF p_enabled THEN
    UPDATE ai_model_deployments SET enabled=true
    WHERE id IN (SELECT deployment_id FROM ai_deployment_revisions WHERE id=ANY(p_deployment_revision_ids));
    UPDATE ai_provider_connections SET enabled=true
    WHERE id IN (
      SELECT connection.connection_id
      FROM ai_deployment_revisions AS deployment
      JOIN ai_connection_revisions AS connection ON connection.id=deployment.connection_revision_id
      WHERE deployment.id=ANY(p_deployment_revision_ids)
    );
  END IF;
  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(
    'ai-control-plane-binding-' || md5(p_request_id || p_revision_id),p_actor_user_id,
    'maintenance.ai_control_plane.binding_updated','ai_binding_policy',policy_row.id,
    jsonb_build_object('reason',btrim(p_reason),'role',p_role,'enabled',p_enabled,
      'deploymentRevisionIds',to_jsonb(p_deployment_revision_ids))::text,p_request_id
  ) ON CONFLICT(id) DO NOTHING;
  RETURN p_revision_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_save_connection_deployment_with_rate_card(
  p_connection_id text,
  p_connection_revision_id text,
  p_connection_name text,
  p_endpoint text,
  p_deployment_id text,
  p_deployment_revision_id text,
  p_deployment_name text,
  p_model_id text,
  p_context_window integer,
  p_max_output_tokens integer,
  p_supports_streaming boolean,
  p_supports_structured_output boolean,
  p_rate_card_revision_id text,
  p_currency text,
  p_input_cost_per_million text,
  p_output_cost_per_million text,
  p_cached_input_cost_per_million text,
  p_actor_user_id text,
  p_reason text,
  p_request_id text
) RETURNS jsonb AS $$
DECLARE
  saved jsonb;
  next_rate_revision integer;
BEGIN
  IF (p_currency IS NULL)<>(p_input_cost_per_million IS NULL)
    OR (p_currency IS NULL)<>(p_output_cost_per_million IS NULL)
    OR (p_currency IS NULL)<>(p_rate_card_revision_id IS NULL)
    OR (p_currency IS NOT NULL AND (
      p_currency !~ '^[A-Z]{3,8}$'
      OR p_input_cost_per_million !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$'
      OR p_output_cost_per_million !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$'
      OR (p_cached_input_cost_per_million IS NOT NULL
        AND p_cached_input_cost_per_million !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$')
    ))
  THEN RAISE EXCEPTION 'AI_RATE_CARD_INVALID' USING ERRCODE='22023'; END IF;

  saved := ai_save_connection_deployment(
    p_connection_id,p_connection_revision_id,p_connection_name,p_endpoint,
    p_deployment_id,p_deployment_revision_id,p_deployment_name,p_model_id,
    p_context_window,p_max_output_tokens,p_supports_streaming,p_supports_structured_output,
    p_actor_user_id,p_reason,p_request_id
  );
  IF p_currency IS NULL THEN RETURN saved || jsonb_build_object('rateCardRevisionId',NULL); END IF;

  SELECT COALESCE(MAX(revision_number),0)+1 INTO next_rate_revision
  FROM ai_rate_card_revisions WHERE deployment_id=p_deployment_id;
  INSERT INTO ai_rate_card_revisions(
    id,deployment_id,revision_number,currency,input_cost_per_million,output_cost_per_million,
    cached_input_cost_per_million,effective_from,created_by_user_id
  ) VALUES(
    p_rate_card_revision_id,p_deployment_id,next_rate_revision,p_currency,
    p_input_cost_per_million::numeric(30,12),p_output_cost_per_million::numeric(30,12),
    p_cached_input_cost_per_million::numeric(30,12),now(),p_actor_user_id
  );
  UPDATE ai_deployment_revisions SET rate_card_revision_id=p_rate_card_revision_id
  WHERE id=p_deployment_revision_id AND deployment_id=p_deployment_id;
  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(
    'ai-control-plane-rate-' || md5(p_request_id || p_rate_card_revision_id),p_actor_user_id,
    'maintenance.ai_control_plane.rate_card_created','ai_rate_card_revision',p_rate_card_revision_id,
    jsonb_build_object(
      'reason',btrim(p_reason),'deploymentId',p_deployment_id,'currency',p_currency,
      'inputCostPerMillion',p_input_cost_per_million,'outputCostPerMillion',p_output_cost_per_million,
      'cachedInputCostPerMillion',p_cached_input_cost_per_million
    )::text,p_request_id
  ) ON CONFLICT(id) DO NOTHING;
  RETURN saved || jsonb_build_object('rateCardRevisionId',p_rate_card_revision_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_settle_invocation_credits(
  p_invocation_root text,p_settled_credits text
) RETURNS text AS $$
DECLARE
  target_event_id text;
  existing_credits bigint;
  exact_credits bigint;
BEGIN
  IF length(p_invocation_root) NOT BETWEEN 1 AND 160
    OR p_settled_credits !~ '^(0|[1-9][0-9]{0,18})$'
  THEN RAISE EXCEPTION 'AI_INVOCATION_CREDITS_INVALID' USING ERRCODE='22023'; END IF;
  exact_credits := p_settled_credits::bigint;
  SELECT event.id,event.platform_settled_credits INTO target_event_id,existing_credits
  FROM ai_usage_events AS event
  WHERE event.event_kind='succeeded'
    AND left(event.invocation_id,length(p_invocation_root))=p_invocation_root
    AND (length(event.invocation_id)=length(p_invocation_root)
      OR substring(event.invocation_id FROM length(p_invocation_root)+1 FOR 1)=':')
  ORDER BY event.occurred_at DESC,event.event_sequence DESC,event.id DESC
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_INVOCATION_USAGE_MISSING' USING ERRCODE='23503'; END IF;
  IF existing_credits IS NOT NULL AND existing_credits<>exact_credits
  THEN RAISE EXCEPTION 'AI_INVOCATION_CREDITS_CONFLICT' USING ERRCODE='23514'; END IF;
  UPDATE ai_usage_events SET platform_settled_credits=exact_credits WHERE id=target_event_id;
  PERFORM ai_evaluate_budget_alerts(now());
  RETURN target_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_upsert_budget_policy(
  p_id text,p_scope_kind text,p_scope_key text,p_period text,p_limit_amount text,p_unit text,
  p_enabled boolean,p_actor_user_id text,p_reason text,p_request_id text
) RETURNS text AS $$
DECLARE exact_limit numeric(38,12);
BEGIN
  IF p_limit_amount !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$'
    OR p_limit_amount::numeric <= 0 OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'AI_BUDGET_INVALID' USING ERRCODE='22023'; END IF;
  exact_limit := p_limit_amount::numeric(38,12);
  INSERT INTO ai_budget_policies(
    id,scope_kind,scope_key,period,limit_amount,unit,enabled,created_by_user_id
  ) VALUES(p_id,p_scope_kind,p_scope_key,p_period,exact_limit,p_unit,p_enabled,p_actor_user_id)
  ON CONFLICT(scope_kind,scope_key,period,unit) DO UPDATE SET
    limit_amount=EXCLUDED.limit_amount,enabled=EXCLUDED.enabled,updated_at=now();
  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(
    'ai-control-plane-budget-' || md5(p_request_id || p_id),p_actor_user_id,
    'maintenance.ai_control_plane.budget_updated','ai_budget_policy',p_id,
    jsonb_build_object('reason',btrim(p_reason),'scopeKind',p_scope_kind,'scopeKey',p_scope_key,
      'period',p_period,'limitAmount',p_limit_amount,'unit',p_unit,'enabled',p_enabled)::text,p_request_id
  ) ON CONFLICT(id) DO NOTHING;
  RETURN p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_request_probe(
  p_id text,p_deployment_revision_id text,p_actor_user_id text,p_reason text,p_request_id text
) RETURNS text AS $$
DECLARE deployment_row record;
BEGIN
  IF length(btrim(p_reason)) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'AI_PROBE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT deployment.connection_revision_id,deployment.config_fingerprint INTO deployment_row
  FROM ai_deployment_revisions AS deployment WHERE deployment.id=p_deployment_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_PROBE_DEPLOYMENT_MISSING' USING ERRCODE='23503'; END IF;
  INSERT INTO ai_probe_receipts(
    id,connection_revision_id,deployment_revision_id,config_fingerprint,phase,status,requested_by_user_id
  ) VALUES(
    p_id,deployment_row.connection_revision_id,p_deployment_revision_id,
    deployment_row.config_fingerprint,'invocation','requested',p_actor_user_id
  );
  INSERT INTO ai_invocation_receipts(
    invocation_id,request_hash,binding_policy_revision_id,role,operation,traffic_kind,status
  ) VALUES(
    'probe:' || md5(p_id),deployment_row.config_fingerprint,NULL,NULL,'provider_probe','probe','requested'
  );
  INSERT INTO ai_usage_events(
    id,invocation_id,event_sequence,event_kind,consumer,role,deployment_revision_id,
    connection_revision_id,fallback_rank,pricing_state
  ) VALUES(
    'ai-probe-requested-' || md5(p_id),'probe:' || md5(p_id),1,'requested','probe',NULL,
    p_deployment_revision_id,deployment_row.connection_revision_id,0,'unpriced'
  );
  PERFORM ai_evaluate_budget_alerts(now());
  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(
    'ai-control-plane-probe-' || md5(p_request_id || p_id),p_actor_user_id,
    'maintenance.ai_control_plane.probe_requested','ai_probe_receipt',p_id,
    jsonb_build_object('reason',btrim(p_reason),'deploymentRevisionId',p_deployment_revision_id)::text,p_request_id
  ) ON CONFLICT(id) DO NOTHING;
  RETURN p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION ai_rollback_deployment(
  p_deployment_id text,p_source_revision_id text,p_expected_current_revision_id text,
  p_new_revision_id text,p_actor_user_id text,p_reason text,p_request_id text
) RETURNS jsonb AS $$
DECLARE deployment_row ai_model_deployments%ROWTYPE;
DECLARE source_row ai_deployment_revisions%ROWTYPE;
DECLARE next_revision integer;
BEGIN
  IF length(btrim(p_reason)) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'AI_ROLLBACK_REASON_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO deployment_row FROM ai_model_deployments WHERE id=p_deployment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_DEPLOYMENT_MISSING' USING ERRCODE='23503'; END IF;
  IF deployment_row.current_revision_id<>p_expected_current_revision_id
  THEN RAISE EXCEPTION 'AI_DEPLOYMENT_STALE' USING ERRCODE='40001'; END IF;
  IF p_source_revision_id=p_expected_current_revision_id THEN
    RETURN jsonb_build_object('deploymentRevisionId',p_source_revision_id,'replayed',true);
  END IF;
  SELECT * INTO source_row FROM ai_deployment_revisions
  WHERE id=p_source_revision_id AND deployment_id=p_deployment_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_DEPLOYMENT_REVISION_MISSING' USING ERRCODE='23503'; END IF;
  SELECT COALESCE(MAX(revision_number),0)+1 INTO next_revision
  FROM ai_deployment_revisions WHERE deployment_id=p_deployment_id;
  INSERT INTO ai_deployment_revisions(
    id,deployment_id,revision_number,connection_revision_id,model_id,context_window,max_output_tokens,
    supports_streaming,supports_structured_output,invocation_parameters_json,capability_metadata_json,
    rate_card_revision_id,config_fingerprint,created_by_user_id
  ) VALUES(
    p_new_revision_id,p_deployment_id,next_revision,source_row.connection_revision_id,source_row.model_id,
    source_row.context_window,source_row.max_output_tokens,source_row.supports_streaming,
    source_row.supports_structured_output,source_row.invocation_parameters_json,source_row.capability_metadata_json,
    source_row.rate_card_revision_id,source_row.config_fingerprint,p_actor_user_id
  );
  UPDATE ai_model_deployments SET current_revision_id=p_new_revision_id,enabled=false,
    updated_by_user_id=p_actor_user_id,updated_at=now() WHERE id=p_deployment_id;
  INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id)
  VALUES(
    'ai-control-plane-rollback-' || md5(p_request_id || p_new_revision_id),p_actor_user_id,
    'maintenance.ai_control_plane.deployment_rolled_back','ai_model_deployment',p_deployment_id,
    jsonb_build_object('reason',btrim(p_reason),'sourceRevisionId',p_source_revision_id,
      'deploymentRevisionId',p_new_revision_id)::text,p_request_id
  ) ON CONFLICT(id) DO NOTHING;
  RETURN jsonb_build_object('deploymentRevisionId',p_new_revision_id,'revisionNumber',next_revision,'replayed',false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT;

REVOKE ALL ON FUNCTION ai_save_connection_deployment(text,text,text,text,text,text,text,text,integer,integer,boolean,boolean,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_save_connection_deployment_with_rate_card(text,text,text,text,text,text,text,text,integer,integer,boolean,boolean,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_settle_invocation_credits(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_update_binding_policy(text,text,text[],boolean,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_upsert_budget_policy(text,text,text,text,text,text,boolean,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_request_probe(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_rollback_deployment(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_evaluate_budget_alerts(timestamptz) FROM PUBLIC;

CREATE OR REPLACE VIEW maintenance_ai_control_plane_snapshot_safe
WITH (security_barrier=true)
AS
SELECT
  role.role,
  role.consumer,
  CASE
    WHEN policy.enabled=false THEN 'disabled'
    ELSE role.default_runtime_state
  END AS runtime_state,
  policy.id AS binding_policy_id,
  policy.current_revision_id AS binding_policy_revision_id,
  target.target_rank,
  deployment.id AS deployment_id,
  deployment.name AS deployment_name,
  deployment_revision.id AS deployment_revision_id,
  deployment_revision.revision_number AS deployment_revision_number,
  deployment_revision.model_id,
  connection.id AS connection_id,
  connection.name AS connection_name,
  connection_revision.id AS connection_revision_id,
  probe.status AS latest_probe_status,
  probe.completed_at AS latest_probe_completed_at,
  (probe.config_fingerprint=deployment_revision.config_fingerprint) AS probe_matches_configuration,
  policy.updated_at AS binding_updated_at
FROM ai_control_plane_roles AS role
LEFT JOIN ai_binding_policies AS policy ON policy.role=role.role
LEFT JOIN ai_binding_targets AS target ON target.binding_policy_revision_id=policy.current_revision_id
LEFT JOIN ai_deployment_revisions AS deployment_revision ON deployment_revision.id=target.deployment_revision_id
LEFT JOIN ai_model_deployments AS deployment ON deployment.id=deployment_revision.deployment_id
LEFT JOIN ai_connection_revisions AS connection_revision ON connection_revision.id=deployment_revision.connection_revision_id
LEFT JOIN ai_provider_connections AS connection ON connection.id=connection_revision.connection_id
LEFT JOIN LATERAL (
  SELECT receipt.status,receipt.completed_at,receipt.config_fingerprint
  FROM ai_probe_receipts AS receipt
  WHERE receipt.deployment_revision_id=deployment_revision.id
  ORDER BY receipt.completed_at DESC NULLS LAST,receipt.requested_at DESC
  LIMIT 1
) AS probe ON true;

COMMENT ON VIEW maintenance_ai_control_plane_snapshot_safe IS
  'Safe control-plane projection. Excludes endpoints, secret references, fingerprints, provider request identifiers, prompts and responses.';

CREATE OR REPLACE VIEW maintenance_ai_connections_safe
WITH (security_barrier=true)
AS
SELECT connection.id,connection.name,connection.adapter_id,connection.enabled,
  connection.current_revision_id,(revision.secret_ref IS NOT NULL) AS has_secret,
  connection.created_at,connection.updated_at
FROM ai_provider_connections AS connection
LEFT JOIN ai_connection_revisions AS revision ON revision.id=connection.current_revision_id;

CREATE OR REPLACE VIEW maintenance_ai_deployments_safe
WITH (security_barrier=true)
AS
SELECT
  deployment.id,deployment.name,deployment.enabled,deployment.current_revision_id,
  connection_revision.connection_id,revision.model_id,revision.context_window,revision.max_output_tokens,
  revision.supports_streaming,revision.supports_structured_output,
  deployment.created_at,deployment.updated_at,
  rate.id AS rate_card_revision_id,rate.currency,
  rate.input_cost_per_million,rate.output_cost_per_million,rate.cached_input_cost_per_million,
  rate.effective_from AS rate_effective_from
FROM ai_model_deployments AS deployment
LEFT JOIN ai_deployment_revisions AS revision ON revision.id=deployment.current_revision_id
LEFT JOIN ai_connection_revisions AS connection_revision ON connection_revision.id=revision.connection_revision_id
LEFT JOIN ai_rate_card_revisions AS rate ON rate.id=revision.rate_card_revision_id;

CREATE OR REPLACE VIEW maintenance_ai_probe_receipts_safe
WITH (security_barrier=true)
AS
SELECT
  id,deployment_revision_id,config_fingerprint,status,requested_at AS tested_at,
  completed_at,latency_ms,error_class,discovered_model_ids_json,phase
FROM ai_probe_receipts;

CREATE OR REPLACE VIEW maintenance_ai_budgets_safe
WITH (security_barrier=true)
AS
SELECT id,scope_kind,scope_key,period,unit,limit_amount,warning_threshold_percent,enabled
FROM ai_budget_policies;

CREATE OR REPLACE VIEW maintenance_ai_budget_alerts_safe
WITH (security_barrier=true)
AS
SELECT alert.id,alert.period_start,alert.threshold_percent,alert.observed_amount,alert.status,
  alert.created_at,policy.id AS budget_policy_id,policy.scope_kind,policy.scope_key,policy.period,
  policy.unit,policy.limit_amount
FROM ai_budget_alerts AS alert
JOIN ai_budget_policies AS policy ON policy.id=alert.budget_policy_id;

CREATE OR REPLACE VIEW maintenance_ai_deployment_revisions_safe
WITH (security_barrier=true)
AS
SELECT revision.id,revision.deployment_id,revision.revision_number,deployment.name AS deployment_name,
  connection.name AS connection_name,revision.model_id,revision.context_window,revision.max_output_tokens,
  revision.supports_streaming,revision.supports_structured_output,
  (connection_revision.secret_ref IS NOT NULL) AS has_secret,
  deployment.current_revision_id=revision.id AS is_current,revision.created_at,
  connection.id AS connection_id,rate.id AS rate_card_revision_id,rate.currency,
  rate.input_cost_per_million,rate.output_cost_per_million,rate.cached_input_cost_per_million,
  rate.effective_from AS rate_effective_from,deployment.enabled AS deployment_enabled
FROM ai_deployment_revisions AS revision
JOIN ai_model_deployments AS deployment ON deployment.id=revision.deployment_id
JOIN ai_connection_revisions AS connection_revision ON connection_revision.id=revision.connection_revision_id
JOIN ai_provider_connections AS connection ON connection.id=connection_revision.connection_id
LEFT JOIN ai_rate_card_revisions AS rate ON rate.id=revision.rate_card_revision_id;

CREATE OR REPLACE VIEW client_ai_control_plane_bindings_safe
WITH (security_barrier=true)
AS
SELECT
  CASE policy.role WHEN 'assistant_message' THEN 'report' ELSE 'proposal_a' END AS role,
  policy.role AS control_plane_role,
  deployment.id AS profile_id,
  deployment_revision.id AS revision_id,
  connection.name AS provider_name,
  deployment_revision.model_id AS model_name,
  policy.current_revision_id AS binding_policy_revision_id
FROM ai_binding_policies AS policy
JOIN ai_binding_targets AS target
  ON target.binding_policy_revision_id=policy.current_revision_id AND target.target_rank=0
JOIN ai_deployment_revisions AS deployment_revision ON deployment_revision.id=target.deployment_revision_id
JOIN ai_model_deployments AS deployment ON deployment.id=deployment_revision.deployment_id
JOIN ai_connection_revisions AS connection_revision ON connection_revision.id=deployment_revision.connection_revision_id
JOIN ai_provider_connections AS connection ON connection.id=connection_revision.connection_id
WHERE policy.role IN ('assistant_message','strategy_generation')
  AND policy.enabled AND deployment.enabled AND connection.enabled
  AND connection_revision.secret_ref IS NOT NULL
  AND EXISTS(
    SELECT 1 FROM ai_probe_receipts AS probe
    WHERE probe.deployment_revision_id=deployment_revision.id
      AND probe.config_fingerprint=deployment_revision.config_fingerprint
      AND probe.status='succeeded'
  );

COMMENT ON VIEW client_ai_control_plane_bindings_safe IS
  'Client-safe primary binding projection. Excludes endpoints, secret material, references, fingerprints and provider receipts.';

CREATE OR REPLACE VIEW gateway_client_ai_attribution_safe
WITH (security_barrier=true)
AS
SELECT request.id AS invocation_root,
  md5('agentnovas-ai-usage-v1:' || request.user_id) AS pseudonymized_user_id,
  request.organization_id
FROM client_ai_inference_requests AS request;

COMMENT ON VIEW gateway_client_ai_attribution_safe IS
  'Gateway-safe Client usage attribution. Exposes only the known invocation root, a one-way pseudonym and captured organization.';

CREATE OR REPLACE VIEW worker_ai_deployment_revisions_safe
WITH (security_barrier=true)
AS
SELECT revision.id AS deployment_revision_id,revision.deployment_id,revision.model_id
FROM ai_deployment_revisions AS revision;

COMMENT ON VIEW worker_ai_deployment_revisions_safe IS
  'Worker-safe model labels for pinned task receipts. Excludes endpoints, secrets, fingerprints and provider metadata.';

CREATE OR REPLACE VIEW maintenance_ai_usage_events_v2_safe
WITH (security_barrier=true)
AS
SELECT
  event.occurred_at,
  (event.occurred_at AT TIME ZONE 'UTC')::date AS usage_day,
  event.consumer,
  event.role,
  event.event_kind,
  event.deployment_revision_id,
  deployment_revision.model_id,
  event.connection_revision_id,
  event.fallback_rank,
  event.pseudonymized_user_id,
  event.organization_id,
  event.input_tokens,
  event.output_tokens,
  event.cached_input_tokens,
  event.reasoning_tokens,
  event.queue_latency_ms,
  event.provider_latency_ms,
  event.total_latency_ms,
  event.provider_cost_amount,
  event.provider_cost_currency,
  event.platform_settled_credits,
  event.pricing_state,
  event.error_class
FROM ai_usage_events AS event
LEFT JOIN ai_deployment_revisions AS deployment_revision ON deployment_revision.id=event.deployment_revision_id;

COMMENT ON VIEW maintenance_ai_usage_events_v2_safe IS
  'Safe unified usage projection. Contains pseudonymous attribution and exact metering only; excludes content and provider identifiers.';

REVOKE ALL ON ai_connection_revisions,ai_deployment_revisions,ai_probe_receipts,ai_invocation_receipts,ai_usage_events FROM PUBLIC;
REVOKE ALL ON maintenance_ai_control_plane_snapshot_safe,maintenance_ai_connections_safe,
  maintenance_ai_deployments_safe,maintenance_ai_probe_receipts_safe,maintenance_ai_budgets_safe,
  maintenance_ai_budget_alerts_safe,maintenance_ai_usage_events_v2_safe,client_ai_control_plane_bindings_safe,
  gateway_client_ai_attribution_safe,worker_ai_deployment_revisions_safe FROM PUBLIC;
REVOKE ALL ON maintenance_ai_deployment_revisions_safe FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON maintenance_ai_control_plane_snapshot_safe,maintenance_ai_connections_safe,
      maintenance_ai_deployments_safe,maintenance_ai_probe_receipts_safe,maintenance_ai_budgets_safe,
      maintenance_ai_budget_alerts_safe,maintenance_ai_usage_events_v2_safe TO agentnovas_maint_web;
    GRANT SELECT ON maintenance_ai_deployment_revisions_safe TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_sync_legacy_profile(text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_sync_legacy_binding(text,text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_save_connection_deployment(text,text,text,text,text,text,text,text,integer,integer,boolean,boolean,text,text,text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_save_connection_deployment_with_rate_card(text,text,text,text,text,text,text,text,integer,integer,boolean,boolean,text,text,text,text,text,text,text,text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_update_binding_policy(text,text,text[],boolean,text,text,text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_upsert_budget_policy(text,text,text,text,text,text,boolean,text,text,text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_request_probe(text,text,text,text,text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_rollback_deployment(text,text,text,text,text,text,text) TO agentnovas_maint_web;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT ON client_ai_control_plane_bindings_safe,maintenance_ai_control_plane_snapshot_safe
      TO agentnovas_client_web;
    GRANT EXECUTE ON FUNCTION ai_settle_invocation_credits(text,text) TO agentnovas_client_web;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_research_worker') THEN
    -- The Research Worker role remains NOLOGIN and grant-free until the retired
    -- consumer is explicitly re-enabled through an operational change.
    NULL;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_runtime_worker') THEN
    GRANT SELECT ON worker_ai_deployment_revisions_safe TO agentnovas_runtime_worker;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ai_gateway') THEN
    GRANT SELECT ON gateway_client_ai_attribution_safe TO agentnovas_ai_gateway;
    GRANT EXECUTE ON FUNCTION ai_evaluate_budget_alerts(timestamptz) TO agentnovas_ai_gateway;
  END IF;
END $$;
