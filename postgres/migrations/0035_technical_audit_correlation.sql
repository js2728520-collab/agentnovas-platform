ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS error_code text;

ALTER TABLE platform_demo_admin_commands
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS trace_id text;

CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id
  ON audit_logs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_trace_id
  ON audit_logs(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_demo_admin_commands_request_id
  ON platform_demo_admin_commands(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_demo_admin_commands_trace_id
  ON platform_demo_admin_commands(trace_id) WHERE trace_id IS NOT NULL;
