-- 客户注册在生产上必然失败（42501），根因在 0044 而不是别处。
--
-- 0044 给 audit_logs 加了防篡改哈希链。接链需要先读出当前链尾：
--
--   SELECT chain_seq, row_hash INTO ... FROM audit_logs ORDER BY chain_seq DESC LIMIT 1;
--
-- 但这条 SELECT 跑在**调用方**的权限下，而所有写审计日志的进程角色都只有 INSERT，
-- 没有 SELECT——审计表存着全平台所有人的操作记录，公网进程本就不该读得到。
--
-- 于是任何「插一条审计日志」的动作都会 42501。客户注册的最后一步正是插审计日志，
-- 整条注册链因此全断，而客户只看到「注册失败」。
--
-- 这个 bug 在开发机上完全看不见：本地用超级用户跑，SELECT 一路放行。
-- 只有配了最小权限角色的环境才会暴露。
--
-- 修法不是给客户端角色开 audit_logs 的 SELECT——那等于让公网进程能读全平台审计
-- 记录，为了修一个写入 bug 而开一个读取后门。改为让触发器函数以 owner 身份执行：
-- 接链是审计机制自己的内部动作，本来就不该要求调用方具备读权限。

CREATE OR REPLACE FUNCTION audit_logs_append_chain() RETURNS trigger
LANGUAGE plpgsql
-- 以函数属主（迁移角色）身份执行内部的链尾查询。调用方仍然只需要 INSERT。
SECURITY DEFINER
-- SECURITY DEFINER 函数必须钉住 search_path，否则调用方可以用同名对象劫持函数体。
SET search_path FROM CURRENT
AS $$
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
$$;

-- 防篡改的强度没有变化：链仍然由数据库在插入时计算，应用层给不出 chain_seq /
-- prev_hash / row_hash，改写与删除仍被 enforce_audit_append_only 拒绝。
-- 变的只是「谁来读链尾」——由调用方变成审计机制自己。
