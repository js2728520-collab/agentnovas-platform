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
  binding_policy_revision_id text NOT NULL REFERENCES ai_binding_policy_revisions(id) ON DELETE RESTRICT,
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
    'network','timeout','rate_limited','provider_5xx','authentication','configuration','validation','budget','permission','cancelled'
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
  binding_policy_revision_id text NOT NULL REFERENCES ai_binding_policy_revisions(id) ON DELETE RESTRICT,
  selected_deployment_revision_id text REFERENCES ai_deployment_revisions(id) ON DELETE RESTRICT,
  selected_connection_revision_id text REFERENCES ai_connection_revisions(id) ON DELETE RESTRICT,
  role text NOT NULL REFERENCES ai_control_plane_roles(role) ON DELETE RESTRICT,
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
  error_class text CHECK (error_class IS NULL OR error_class IN (
    'network','timeout','rate_limited','provider_5xx','authentication','configuration','validation','budget','permission','cancelled'
  )),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('succeeded','failed','cancelled'))=(completed_at IS NOT NULL))
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
  limit_amount numeric(38,0) NOT NULL CHECK (limit_amount > 0),
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
  threshold_percent integer NOT NULL CHECK (threshold_percent IN (80,100)),
  observed_amount numeric(38,0) NOT NULL CHECK (observed_amount >= 0),
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
  deployment_revision.model_id,
  connection.id AS connection_id,
  connection.name AS connection_name,
  connection_revision.id AS connection_revision_id,
  probe.status AS latest_probe_status,
  probe.completed_at AS latest_probe_completed_at,
  (probe.config_fingerprint=deployment_revision.config_fingerprint) AS probe_matches_configuration
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
SELECT id,name,adapter_id,enabled,current_revision_id,created_at,updated_at
FROM ai_provider_connections;

CREATE OR REPLACE VIEW maintenance_ai_deployments_safe
WITH (security_barrier=true)
AS
SELECT
  deployment.id,deployment.name,deployment.enabled,deployment.current_revision_id,
  connection_revision.connection_id,deployment.created_at,deployment.updated_at
FROM ai_model_deployments AS deployment
LEFT JOIN ai_deployment_revisions AS revision ON revision.id=deployment.current_revision_id
LEFT JOIN ai_connection_revisions AS connection_revision ON connection_revision.id=revision.connection_revision_id;

CREATE OR REPLACE VIEW maintenance_ai_probe_receipts_safe
WITH (security_barrier=true)
AS
SELECT
  id,config_fingerprint,status,requested_at AS tested_at,latency_ms,error_class,discovered_model_ids_json
FROM ai_probe_receipts;

CREATE OR REPLACE VIEW maintenance_ai_budgets_safe
WITH (security_barrier=true)
AS
SELECT id,scope_kind,scope_key,unit,limit_amount,warning_threshold_percent,enabled
FROM ai_budget_policies;

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
  maintenance_ai_usage_events_v2_safe FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON maintenance_ai_control_plane_snapshot_safe,maintenance_ai_connections_safe,
      maintenance_ai_deployments_safe,maintenance_ai_probe_receipts_safe,maintenance_ai_budgets_safe,
      maintenance_ai_usage_events_v2_safe TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_sync_legacy_profile(text) TO agentnovas_maint_web;
    GRANT EXECUTE ON FUNCTION ai_sync_legacy_binding(text,text) TO agentnovas_maint_web;
  END IF;
END $$;
