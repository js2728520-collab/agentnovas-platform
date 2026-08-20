CREATE TABLE IF NOT EXISTS "worker_instances" (
  "worker_type" text NOT NULL CHECK ("worker_type" IN (
    'research', 'runtime', 'notification', 'payment', 'demo_execution'
  )),
  "instance_id" text NOT NULL,
  "commit_sha" text,
  "status" text NOT NULL DEFAULT 'starting' CHECK ("status" IN (
    'starting', 'running', 'stopping', 'stopped', 'error'
  )),
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "heartbeat_at" timestamptz NOT NULL DEFAULT now(),
  "last_success_at" timestamptz,
  "last_failure_at" timestamptz,
  "last_error_code" text CHECK (
    "last_error_code" IS NULL OR (
      length("last_error_code") BETWEEN 1 AND 80
      AND "last_error_code" ~ '^[A-Z0-9_:-]+$'
    )
  ),
  "current_job_id" text,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("worker_type", "instance_id")
);

CREATE INDEX IF NOT EXISTS "idx_worker_instances_health"
  ON "worker_instances" ("worker_type", "heartbeat_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_worker_instances_failures"
  ON "worker_instances" ("last_failure_at" DESC)
  WHERE "last_failure_at" IS NOT NULL;
