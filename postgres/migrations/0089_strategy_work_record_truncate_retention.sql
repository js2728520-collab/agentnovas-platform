-- DELETE triggers do not fire for TRUNCATE, including TRUNCATE ... CASCADE.
-- Keep the six-month floor for mutable work-record history and make evidence
-- tables that are already append-only permanent against both DELETE and TRUNCATE.

CREATE OR REPLACE FUNCTION enforce_strategy_work_record_truncate_retention()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  retained_at_column text := TG_ARGV[0];
  relation_schema text;
  relation_name text;
  has_recent_record boolean;
BEGIN
  IF retained_at_column IS NULL OR retained_at_column = '' THEN
    RAISE EXCEPTION 'strategy work record truncate retention column is missing';
  END IF;

  -- Resolve the triggering relation by OID, not by TG_TABLE_NAME through the
  -- caller's search_path. A temporary/shadow relation must not change what is
  -- inspected before a CASCADE truncate.
  SELECT namespace.nspname, relation.relname
    INTO relation_schema, relation_name
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.oid = TG_RELID;
  IF relation_schema IS NULL OR relation_name IS NULL THEN
    RAISE EXCEPTION 'strategy work record truncate relation cannot be resolved';
  END IF;

  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1 FROM %I.%I
       WHERE %I IS NULL OR %I > now() - interval ''6 months''
     )',
    relation_schema,
    relation_name,
    retained_at_column,
    retained_at_column
  ) INTO has_recent_record;

  IF has_recent_record THEN
    RAISE EXCEPTION 'six-month minimum retention protects this work record';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION reject_permanent_work_record_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_record boolean;
BEGIN
  -- TG_RELID::regclass is an OID-bound relation identity. It cannot be redirected
  -- to a same-named temporary table through search_path.
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', TG_RELID::regclass)
    INTO has_record;
  IF has_record THEN
    RAISE EXCEPTION 'permanent work-record evidence cannot be truncated';
  END IF;
  RETURN NULL;
END $$;

-- strategy_deployments is mutable history, but its own row must not disappear
-- before the minimum retention period. Its child work-record rows are retained
-- separately by their own timestamp/evidence policy.
DROP TRIGGER IF EXISTS trg_strategy_deployment_retention ON strategy_deployments;
CREATE TRIGGER trg_strategy_deployment_retention
BEFORE DELETE ON strategy_deployments
FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_deployment_truncate_retention ON strategy_deployments;
CREATE TRIGGER trg_strategy_deployment_truncate_retention
BEFORE TRUNCATE ON strategy_deployments
FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_subscription_period_truncate_retention ON strategy_subscription_periods;
CREATE TRIGGER trg_strategy_subscription_period_truncate_retention
BEFORE TRUNCATE ON strategy_subscription_periods
FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_decision_round_truncate_retention ON strategy_decision_rounds;
CREATE TRIGGER trg_strategy_decision_round_truncate_retention
BEFORE TRUNCATE ON strategy_decision_rounds
FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_runtime_event_truncate_retention ON strategy_runtime_events;
CREATE TRIGGER trg_strategy_runtime_event_truncate_retention
BEFORE TRUNCATE ON strategy_runtime_events
FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention('created_at');

DROP TRIGGER IF EXISTS trg_strategy_runtime_cycle_truncate_retention ON strategy_runtime_cycles;
CREATE TRIGGER trg_strategy_runtime_cycle_truncate_retention
BEFORE TRUNCATE ON strategy_runtime_cycles
FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention('completed_at');

DROP TRIGGER IF EXISTS trg_market_data_snapshot_truncate_retention ON market_data_snapshots;
CREATE TRIGGER trg_market_data_snapshot_truncate_retention
BEFORE TRUNCATE ON market_data_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention('created_at');

DROP TRIGGER IF EXISTS trg_official_paper_intent_truncate_retention ON official_paper_order_intents;
CREATE TRIGGER trg_official_paper_intent_truncate_retention
BEFORE TRUNCATE ON official_paper_order_intents
FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention('created_at');

-- These deployment-cascade children are mutable history rather than permanent
-- accounting facts. Retain them for six months, including when a parent table is
-- truncated with CASCADE. NULL close timestamps keep open positions protected.
DO $$
DECLARE
  record record;
BEGIN
  FOR record IN
    SELECT * FROM (VALUES
      ('strategy_runtime_explanation_jobs', 'created_at'),
      ('strategy_paper_positions', 'closed_at'),
      ('strategy_paper_funding_accruals', 'created_at'),
      ('strategy_paper_order_intents', 'created_at'),
      ('strategy_follow_paper_positions', 'closed_at'),
      ('strategy_follow_paper_order_intents', 'created_at')
    ) AS retained(table_name, retained_at_column)
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), record.table_name)) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I.%I',
        'trg_' || record.table_name || '_retention', current_schema(), record.table_name
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION enforce_strategy_work_record_minimum_retention(%L)',
        'trg_' || record.table_name || '_retention', current_schema(), record.table_name,
        record.retained_at_column
      );
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON %I.%I',
        'trg_' || record.table_name || '_truncate_retention', current_schema(), record.table_name
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION enforce_strategy_work_record_truncate_retention(%L)',
        'trg_' || record.table_name || '_truncate_retention', current_schema(), record.table_name,
        record.retained_at_column
      );
    END IF;
  END LOOP;
END $$;

-- These tables are append-only facts, not six-month-cleanable history. Their
-- trigger must fire when they are reached directly or through CASCADE.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'official_paper_fill_receipts',
    'official_paper_ledger_entries',
    'live_execution_receipts',
    'live_book_postings',
    'strategy_follow_paper_fill_receipts'
  ] LOOP
    IF to_regclass(format('%I.%I', current_schema(), table_name)) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || table_name || '_truncate_permanent', table_name);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_permanent_work_record_truncate()',
        'trg_' || table_name || '_truncate_permanent', table_name
      );
    END IF;
  END LOOP;
END $$;
