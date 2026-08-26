-- 审计防篡改。
--
-- 背景：0022 已经把资金表锁死（append-only + 借贷平衡 + 幂等），但审计侧没有任何
-- 保护——audit_logs 和各 *_decisions 表可以被有写权限的人修改或删除。对一个靠
-- maker/checker 双人复核立身的系统，这意味着「谁批准了什么」的记录可以被伪造：
-- 插一条假的 decision 行就能让单人操作看起来像双人复核。
--
-- 本迁移做两件事：
--   1. audit_logs 加哈希链，任何对历史行的改动都会让链断裂并可被检出。
--   2. audit_logs 与 8 张 decisions 表加 append-only 触发器，UPDATE/DELETE 直接拒绝。
--
-- 哈希链会让 audit_logs 的插入串行化（事务级 advisory lock）。这是刻意的：
-- 审计需要一个全序。当前 27 个写入点都是离散业务动作，不在请求热路径上。

-- ---------------------------------------------------------------------------
-- 1. 链字段
-- ---------------------------------------------------------------------------

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS chain_seq bigint,
  ADD COLUMN IF NOT EXISTS prev_hash bytea,
  ADD COLUMN IF NOT EXISTS row_hash bytea;

-- 规范化：用 jsonb 文本表示，键顺序由 Postgres 保证确定，且能区分 NULL 与空串。
-- 链字段自身必须排除，否则自引用。
CREATE OR REPLACE FUNCTION audit_log_canonical_bytes(payload jsonb) RETURNS bytea AS $$
  SELECT convert_to((payload - 'chain_seq' - 'prev_hash' - 'row_hash')::text, 'UTF8');
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- 2. 回填存量行
--    必须在建 append-only 触发器之前做，否则自己会被自己拦住。
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  row_record record;
  running_hash bytea := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  running_seq bigint := 0;
  canonical bytea;
BEGIN
  FOR row_record IN
    SELECT * FROM audit_logs WHERE row_hash IS NULL ORDER BY created_at, id
  LOOP
    running_seq := running_seq + 1;
    canonical := audit_log_canonical_bytes(to_jsonb(row_record));
    UPDATE audit_logs
       SET chain_seq = running_seq,
           prev_hash = running_hash,
           row_hash = sha256(running_hash || canonical)
     WHERE id = row_record.id;
    running_hash := sha256(running_hash || canonical);
  END LOOP;
END $$;

ALTER TABLE audit_logs
  ALTER COLUMN chain_seq SET NOT NULL,
  ALTER COLUMN prev_hash SET NOT NULL,
  ALTER COLUMN row_hash  SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_chain_seq ON audit_logs (chain_seq);

-- ---------------------------------------------------------------------------
-- 3. 插入时接链
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_logs_append_chain() RETURNS trigger AS $$
DECLARE
  tail_seq bigint;
  tail_hash bytea;
  canonical bytea;
BEGIN
  -- 事务级锁：审计需要全序，并发插入必须串行接链。
  PERFORM pg_advisory_xact_lock(hashtext('audit_logs_chain')::bigint);

  SELECT chain_seq, row_hash INTO tail_seq, tail_hash
    FROM audit_logs ORDER BY chain_seq DESC LIMIT 1;

  NEW.chain_seq := COALESCE(tail_seq, 0) + 1;
  NEW.prev_hash := COALESCE(
    tail_hash,
    '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea
  );

  canonical := audit_log_canonical_bytes(to_jsonb(NEW));
  NEW.row_hash := sha256(NEW.prev_hash || canonical);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_chain ON audit_logs;
CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_chain();

-- ---------------------------------------------------------------------------
-- 4. append-only
--    审计与复核记录一经写入不可更改。需要更正时追加一条新的审计事件说明，
--    而不是修改历史——与账本的反向分录同一原则。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: % 不可修改或删除', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_append_only();

DO $$
DECLARE
  decision_table text;
BEGIN
  FOREACH decision_table IN ARRAY ARRAY[
    'approval_decisions',
    'access_change_decisions',
    'ai_credit_adjustment_decisions',
    'commercial_membership_order_decisions',
    'customer_attribution_change_decisions',
    'deposit_action_decisions',
    'performance_fee_decisions',
    'platform_decisions'
  ]
  LOOP
    IF to_regclass(decision_table) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', decision_table || '_append_only', decision_table);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_audit_append_only()',
        decision_table || '_append_only', decision_table
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. 校验函数
--    运维端「技术审计」页面和恢复演练调用它证明链未被篡改。
--    返回空集合表示区间内完整。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION verify_audit_log_chain(
  from_seq bigint DEFAULT 1,
  to_seq bigint DEFAULT NULL
) RETURNS TABLE (chain_seq bigint, id text, reason text) AS $$
DECLARE
  row_record record;
  expected_prev bytea;
  expected_seq bigint;
  canonical bytea;
BEGIN
  IF from_seq <= 1 THEN
    expected_prev := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
    expected_seq := 1;
  ELSE
    SELECT a.row_hash INTO expected_prev FROM audit_logs a WHERE a.chain_seq = from_seq - 1;
    expected_seq := from_seq;
  END IF;

  FOR row_record IN
    SELECT * FROM audit_logs a
     WHERE a.chain_seq >= from_seq AND (to_seq IS NULL OR a.chain_seq <= to_seq)
     ORDER BY a.chain_seq
  LOOP
    IF row_record.chain_seq <> expected_seq THEN
      chain_seq := row_record.chain_seq; id := row_record.id;
      reason := format('序号断裂：期望 %s', expected_seq);
      RETURN NEXT;
    END IF;

    IF expected_prev IS NOT NULL AND row_record.prev_hash <> expected_prev THEN
      chain_seq := row_record.chain_seq; id := row_record.id;
      reason := 'prev_hash 与上一行的 row_hash 不匹配';
      RETURN NEXT;
    END IF;

    canonical := audit_log_canonical_bytes(to_jsonb(row_record));
    IF row_record.row_hash <> sha256(row_record.prev_hash || canonical) THEN
      chain_seq := row_record.chain_seq; id := row_record.id;
      reason := 'row_hash 与行内容不匹配，内容已被改动';
      RETURN NEXT;
    END IF;

    expected_prev := row_record.row_hash;
    expected_seq := row_record.chain_seq + 1;
  END LOOP;

  RETURN;
END;
$$ LANGUAGE plpgsql STABLE;
