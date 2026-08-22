-- 审计链尾锚定。
--
-- 背景：0044 给 audit_logs 加了哈希链，改内容或删中间行都会让链断裂并被
-- verify_audit_log_chain() 检出。但**截断链尾检不出来**——把最后 N 行删掉，
-- 剩下的链依然自洽。链内校验无法自证「本该还有多少行」。
--
-- 做法：定期把当时的链尾（chain_seq + row_hash + 行数）登记成一条锚点。
-- 之后校验锚点：被锚定的那个 chain_seq 若已不存在，或它的 row_hash 变了，
-- 就是截断或篡改。
--
-- 边界要说清楚：锚点存在同一个库里，拥有完整写权限的人理论上可以连锚点一起删。
-- append-only 触发器把门槛抬高（要先删触发器），但**真正的防线是把锚点导出到
-- 库外**——运维端提供导出，导出动作本身也进审计。本迁移只负责让「截断可被发现」
-- 这件事在库内成立。

CREATE TABLE IF NOT EXISTS audit_chain_anchors (
  id text PRIMARY KEY,
  -- 锚定时刻的链尾。
  chain_seq bigint NOT NULL,
  row_hash bytea NOT NULL,
  -- 冗余记录当时的总行数：即使有人补写了一条 chain_seq 相同的假行，
  -- 行数对不上也是一个独立的信号。
  entry_count bigint NOT NULL CHECK (entry_count >= 0),
  anchored_at timestamptz NOT NULL DEFAULT now(),
  anchored_by text NOT NULL,
  UNIQUE (chain_seq)
);

CREATE INDEX IF NOT EXISTS idx_audit_chain_anchors_latest
  ON audit_chain_anchors (anchored_at DESC);

-- 锚点自身必须 append-only：可改的锚点等于没有锚点。
-- 复用 0044 建立的函数。
DROP TRIGGER IF EXISTS audit_chain_anchors_append_only ON audit_chain_anchors;
CREATE TRIGGER audit_chain_anchors_append_only
  BEFORE UPDATE OR DELETE ON audit_chain_anchors
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_append_only();

-- 校验全部锚点。返回空集表示没有发现截断或篡改。
CREATE OR REPLACE FUNCTION verify_audit_chain_anchors()
RETURNS TABLE (anchor_id text, chain_seq bigint, reason text) AS $$
DECLARE
  anchor_record record;
  current_hash bytea;
  current_count bigint;
BEGIN
  SELECT count(*) INTO current_count FROM audit_logs;

  FOR anchor_record IN
    SELECT * FROM audit_chain_anchors ORDER BY chain_seq
  LOOP
    SELECT a.row_hash INTO current_hash
      FROM audit_logs a WHERE a.chain_seq = anchor_record.chain_seq;

    IF current_hash IS NULL THEN
      -- 被锚定的那一行不见了：这正是链内校验发现不了的截断。
      anchor_id := anchor_record.id;
      chain_seq := anchor_record.chain_seq;
      reason := '锚定的审计行已不存在（链尾被截断或该行被删除）';
      RETURN NEXT;
    ELSIF current_hash IS DISTINCT FROM anchor_record.row_hash THEN
      anchor_id := anchor_record.id;
      chain_seq := anchor_record.chain_seq;
      reason := '锚定行的哈希与登记值不一致（内容被改写）';
      RETURN NEXT;
    ELSIF current_count < anchor_record.entry_count THEN
      -- 哈希对得上但总行数变少了：说明被锚定行之外还有行被删掉。
      anchor_id := anchor_record.id;
      chain_seq := anchor_record.chain_seq;
      reason := format('审计行数由 %s 降至 %s（有行被删除）', anchor_record.entry_count, current_count);
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
