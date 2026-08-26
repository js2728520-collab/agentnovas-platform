-- Maintenance 受控导出（T4.13b / WR4）。
--
-- Maintenance 的产品边界是「不展示客户业务信息」。导出工作记录是这条边界上的一个
-- 例外，因此它不能通过让运维端直接读业务原表来实现——那等于为了一个导出把整张
-- 客户决策链对运维端敞开。这里建一个 security-barrier 安全视图作为唯一入口：
-- 视图只投影 allowlist 字段，用户只有单向伪名，运维端数据库角色只拿到该视图的
-- SELECT，拿不到底表。
--
-- security_barrier 不是装饰：没有它，规划器可能把调用方传入的函数/操作符下推到
-- 视图内部先于安全条件求值，从而侧信道泄露被投影掉的行。

CREATE OR REPLACE VIEW maintenance_strategy_work_records_safe
WITH (security_barrier = true)
AS
-- 共享决策轮：公共判断本身不含客户数据，客户维度只来自 period/deployment 的归属。
SELECT
  round.id AS record_id,
  true AS is_shared_decision,
  round.candle_close_time AS occurred_at,
  (round.candle_close_time AT TIME ZONE 'UTC')::date AS occurred_day,
  round.candle_open_time AS candle_open_at,
  round.strategy_code,
  round.strategy_version_id,
  round.symbol,
  round.timeframe,
  COALESCE(round.decision_json->>'action', 'monitoring') AS decision_status,
  round.completeness,
  period.mode AS execution_mode,
  -- 与 Client 侧同一套判定：只有纯 hold 且没有客户周期才是「无需准入」，
  -- 其余缺周期一律「未记录」。导出口径与客户看到的必须一致，否则同一轮在两处
  -- 会有两种解释。
  CASE
    WHEN cycle.id IS NULL AND COALESCE(round.decision_json->>'action', 'hold') = 'hold' THEN 'not_required'
    WHEN cycle.id IS NULL THEN 'not_recorded'
    WHEN cycle.status = 'failed' THEN 'failed'
    WHEN cycle.decision_json->>'riskApproved' = 'false' THEN 'risk_rejected'
    ELSE 'recorded'
  END AS admission_status,
  -- 单向伪名。md5 不是保密算法，这里也不当保密用：它的作用是让同一位客户在导出
  -- 里可被关联，而拿到导出的人无法反推回用户 ID 以外的任何身份信息。原始用户 ID、
  -- 邮箱、手机号、客户名称一律不出现在视图里。
  md5(deployment.owner_user_id) AS customer_pseudonym,
  snapshot.exchange AS market_source,
  snapshot.candle_count,
  snapshot.data_start,
  snapshot.data_end,
  (SELECT count(*) FROM official_paper_order_intents intent
    WHERE intent.runtime_cycle_id = cycle.id) AS order_intent_count,
  (SELECT count(*) FROM official_paper_fill_receipts receipt
     JOIN official_paper_order_intents intent ON intent.id = receipt.intent_id
    WHERE intent.runtime_cycle_id = cycle.id) AS fill_receipt_count,
  round.trace_id
FROM strategy_subscription_periods AS period
JOIN strategy_deployments AS deployment
  ON deployment.id = period.deployment_id
JOIN strategy_decision_rounds AS round
  ON round.strategy_code = period.strategy_code
 AND round.symbol = period.symbol
 AND round.strategy_version_id = period.strategy_version_id
 AND round.candle_close_time >= period.started_at
 AND (period.ended_at IS NULL OR round.candle_close_time <= period.ended_at)
LEFT JOIN LATERAL (
  SELECT candidate.* FROM strategy_runtime_cycles AS candidate
  WHERE candidate.deployment_id = period.deployment_id
    AND candidate.decision_round_id = round.id
  ORDER BY candidate.completed_at DESC, candidate.id DESC LIMIT 1
) AS cycle ON true
LEFT JOIN market_data_snapshots AS snapshot
  ON snapshot.id = round.market_data_snapshot_id

UNION ALL

-- 过渡期没有共享轮的历史记录，身份用客户周期 ID。
SELECT
  cycle.id AS record_id,
  false AS is_shared_decision,
  cycle.candle_close_time AS occurred_at,
  (cycle.candle_close_time AT TIME ZONE 'UTC')::date AS occurred_day,
  cycle.candle_open_time AS candle_open_at,
  period.strategy_code,
  period.strategy_version_id,
  period.symbol,
  COALESCE(NULLIF(cycle.decision_json->>'timeframe', ''), '1h') AS timeframe,
  COALESCE(cycle.decision_json->>'action', 'monitoring') AS decision_status,
  'legacy'::text AS completeness,
  period.mode AS execution_mode,
  CASE
    WHEN cycle.status = 'failed' THEN 'failed'
    WHEN cycle.decision_json->>'riskApproved' = 'false' THEN 'risk_rejected'
    ELSE 'recorded'
  END AS admission_status,
  md5(deployment.owner_user_id) AS customer_pseudonym,
  snapshot.exchange AS market_source,
  snapshot.candle_count,
  snapshot.data_start,
  snapshot.data_end,
  (SELECT count(*) FROM official_paper_order_intents intent
    WHERE intent.runtime_cycle_id = cycle.id) AS order_intent_count,
  (SELECT count(*) FROM official_paper_fill_receipts receipt
     JOIN official_paper_order_intents intent ON intent.id = receipt.intent_id
    WHERE intent.runtime_cycle_id = cycle.id) AS fill_receipt_count,
  cycle.trace_id
FROM strategy_subscription_periods AS period
JOIN strategy_deployments AS deployment
  ON deployment.id = period.deployment_id
JOIN strategy_runtime_cycles AS cycle
  ON cycle.deployment_id = period.deployment_id
 AND cycle.decision_round_id IS NULL
 AND cycle.candle_close_time >= period.started_at
 AND (period.ended_at IS NULL OR cycle.candle_close_time <= period.ended_at)
LEFT JOIN market_data_snapshots AS snapshot
  ON snapshot.id = cycle.market_data_snapshot_id;

COMMENT ON VIEW maintenance_strategy_work_records_safe IS
  'Least-privilege work record projection for Maintenance export. Exposes only a one-way customer pseudonym and allowlisted decision facts; excludes raw user identifiers, customer PII, exchange accounts, raw evidence/payload JSON, model names, provider identifiers, error text and secrets.';

REVOKE ALL ON maintenance_strategy_work_records_safe FROM PUBLIC;

-- 运维端只拿视图，不拿底表。缺角色的环境（本地 SQLite/开发库）跳过而不是失败：
-- 角色供给属于部署职责，迁移不负责创建它们。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON maintenance_strategy_work_records_safe TO agentnovas_maint_web;
    REVOKE ALL ON strategy_decision_rounds FROM agentnovas_maint_web;
    REVOKE ALL ON strategy_runtime_cycles FROM agentnovas_maint_web;
    REVOKE ALL ON strategy_runtime_events FROM agentnovas_maint_web;
    REVOKE ALL ON strategy_subscription_periods FROM agentnovas_maint_web;
    REVOKE ALL ON official_paper_order_intents FROM agentnovas_maint_web;
    REVOKE ALL ON official_paper_fill_receipts FROM agentnovas_maint_web;
  END IF;
END $$;

-- 幂等操作名在数据库里也有 allowlist（0039）。只在 TypeScript 侧加枚举不够：
-- 应用层认为合法，数据库直接 23514 拒绝，表现是导出接口 500。
ALTER TABLE maintenance_idempotency_records
  DROP CONSTRAINT IF EXISTS maintenance_idempotency_records_operation_check;
ALTER TABLE maintenance_idempotency_records
  ADD CONSTRAINT maintenance_idempotency_records_operation_check
  CHECK (operation IN (
    'maintenance.source_integration.test',
    'maintenance.trading.emergency_stop',
    'maintenance.work_records.export'
  ));

-- 导出是按天筛选的，热路径是 occurred_at 上的范围扫描。
CREATE INDEX IF NOT EXISTS idx_strategy_decision_rounds_export_day
  ON strategy_decision_rounds (candle_close_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_cycles_export_day
  ON strategy_runtime_cycles (candle_close_time DESC, id DESC)
  WHERE decision_round_id IS NULL;

-- 导出是独立敏感权限，不搭在 `maint.audit.view` 或 `maint.ai_usage.view` 上：
-- 能看聚合用量不等于能导出逐条客户决策记录。标 sensitive，这样 MFA 强制开启后
-- 自动获得 recent-MFA 门槛，不需要再改一次代码。
INSERT INTO "permission_definitions" ("key", "application_id", "label", "sensitive", "status")
VALUES ('maint.work_records.export', 'maintenance', '导出脱敏工作记录', true, 'active')
ON CONFLICT ("key") DO UPDATE
  SET "application_id" = EXCLUDED."application_id",
      "label" = EXCLUDED."label",
      "sensitive" = EXCLUDED."sensitive",
      "status" = EXCLUDED."status";

WITH synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT
    'bootstrap-role-permission-' || md5(identity.role_id || ':maint.work_records.export'),
    identity.role_id,
    'maint.work_records.export',
    'PLATFORM',
    '[]'::jsonb
  FROM system_role_identities AS identity
  WHERE identity.system_key='bootstrap_admin'
    AND identity.application_id='maintenance'
  ON CONFLICT(role_id,permission_key) DO UPDATE SET
    scope='PLATFORM',
    scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0076-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.bootstrap_role_permission_synchronized',
  'role',
  role_id,
  jsonb_build_object(
    'permissionKey',permission_key,
    'scope','PLATFORM',
    'migration','0076_maintenance_work_record_export'
  )::text
FROM synchronized
ON CONFLICT(id) DO NOTHING;
