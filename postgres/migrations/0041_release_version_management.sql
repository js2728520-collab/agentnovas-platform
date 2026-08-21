INSERT INTO permission_definitions(key,application_id,label,description,sensitive,status)
VALUES
  ('maint.releases.view','maintenance','查看发布版本','查看不可变版本、验证与环境部署证据',false,'active'),
  ('maint.releases.manage','maintenance','登记发布版本','登记 Git、构建产物和迁移版本身份',true,'active'),
  ('maint.releases.approve','maintenance','复核发布与回滚证据','独立复核版本并登记部署或回滚结果',true,'active')
ON CONFLICT(key) DO UPDATE SET
  application_id=EXCLUDED.application_id,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sensitive=EXCLUDED.sensitive,
  status=EXCLUDED.status,
  updated_at=now();

CREATE TABLE release_versions (
  id text PRIMARY KEY,
  version_tag text NOT NULL UNIQUE CHECK (version_tag ~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([-+][0-9A-Za-z.-]+)?$'),
  channel text NOT NULL CHECK (channel IN ('beta','stable')),
  commit_sha text NOT NULL UNIQUE CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  migration_version text NOT NULL CHECK (migration_version ~ '^[0-9]{4}_[a-z0-9_]{3,96}$'),
  release_notes text NOT NULL CHECK (length(release_notes) BETWEEN 10 AND 10000),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(created_by_user_id,idempotency_key)
);

CREATE TABLE release_verifications (
  id text PRIMARY KEY,
  release_version_id text NOT NULL UNIQUE REFERENCES release_versions(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  ci_run_url text CHECK (ci_run_url IS NULL OR length(ci_run_url) BETWEEN 1 AND 500),
  reviewer_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(reviewer_user_id,idempotency_key)
);

CREATE TABLE release_deployments (
  id text PRIMARY KEY,
  sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  release_version_id text NOT NULL REFERENCES release_versions(id) ON DELETE RESTRICT,
  previous_release_version_id text REFERENCES release_versions(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('staging','production')),
  action text NOT NULL CHECK (action IN ('deploy','rollback')),
  status text NOT NULL CHECK (status IN ('succeeded','failed')),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_user_id,idempotency_key),
  CHECK (previous_release_version_id IS NULL OR previous_release_version_id <> release_version_id)
);

CREATE INDEX idx_release_versions_created ON release_versions(created_at DESC,id DESC);
CREATE INDEX idx_release_deployments_environment ON release_deployments(environment,status,sequence_no DESC);
CREATE INDEX idx_release_deployments_release ON release_deployments(release_version_id,sequence_no DESC);

CREATE OR REPLACE FUNCTION protect_release_management_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'release management records are immutable';
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION protect_release_management_append_only() FROM PUBLIC;

CREATE TRIGGER trg_release_versions_immutable BEFORE UPDATE OR DELETE ON release_versions
FOR EACH ROW EXECUTE FUNCTION protect_release_management_append_only();
CREATE TRIGGER trg_release_verifications_immutable BEFORE UPDATE OR DELETE ON release_verifications
FOR EACH ROW EXECUTE FUNCTION protect_release_management_append_only();
CREATE TRIGGER trg_release_deployments_immutable BEFORE UPDATE OR DELETE ON release_deployments
FOR EACH ROW EXECUTE FUNCTION protect_release_management_append_only();

WITH synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT
    'bootstrap-role-permission-' || md5(identity.role_id || ':' || permission.key),
    identity.role_id,
    permission.key,
    'PLATFORM',
    '[]'::jsonb
  FROM system_role_identities AS identity
  JOIN permission_definitions AS permission ON permission.application_id=identity.application_id AND permission.status='active'
  WHERE identity.system_key='bootstrap_admin' AND permission.key LIKE 'maint.releases.%'
  ON CONFLICT(role_id,permission_key) DO UPDATE SET scope='PLATFORM',scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0041-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.bootstrap_role_permission_synchronized',
  'role',
  role_id,
  jsonb_build_object('permissionKey',permission_key,'scope','PLATFORM','migration','0041_release_version_management')::text
FROM synchronized
ON CONFLICT(id) DO NOTHING;

REVOKE ALL ON release_versions,release_verifications,release_deployments FROM PUBLIC;
