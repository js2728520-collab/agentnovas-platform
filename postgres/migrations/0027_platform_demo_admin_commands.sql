CREATE TABLE IF NOT EXISTS platform_demo_admin_commands (
  id text PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN ('control','verify')),
  idempotency_key text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES platform_demo_accounts(id) ON DELETE RESTRICT,
  action text NOT NULL,
  strategy_code text,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 500),
  canonical_payload_sha256 text NOT NULL
    CHECK (canonical_payload_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','failed')),
  response_json jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (operation,idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_demo_admin_commands_account
  ON platform_demo_admin_commands(account_id,created_at DESC,id DESC);

REVOKE UPDATE, DELETE ON platform_demo_admin_commands FROM PUBLIC;

CREATE OR REPLACE FUNCTION forbid_platform_demo_admin_command_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform Demo admin commands are append-only';
  END IF;
  IF OLD.operation IS DISTINCT FROM NEW.operation
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.actor_user_id IS DISTINCT FROM NEW.actor_user_id
     OR OLD.account_id IS DISTINCT FROM NEW.account_id
     OR OLD.action IS DISTINCT FROM NEW.action
     OR OLD.strategy_code IS DISTINCT FROM NEW.strategy_code
     OR OLD.reason IS DISTINCT FROM NEW.reason
     OR OLD.canonical_payload_sha256 IS DISTINCT FROM NEW.canonical_payload_sha256
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'platform Demo admin command identity is immutable';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'platform Demo admin command terminal state is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_platform_demo_admin_command_immutable
  ON platform_demo_admin_commands;
CREATE TRIGGER trg_platform_demo_admin_command_immutable
BEFORE UPDATE OR DELETE ON platform_demo_admin_commands
FOR EACH ROW EXECUTE FUNCTION forbid_platform_demo_admin_command_mutation();
