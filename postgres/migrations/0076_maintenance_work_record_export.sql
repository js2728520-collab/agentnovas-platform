INSERT INTO permission_definitions(key,application_id,label,description,sensitive,status)
VALUES (
  'maint.work_records.export',
  'maintenance',
  '导出脱敏工作记录',
  '按受控日期范围导出客户策略工作记录的脱敏安全投影',
  true,
  'active'
)
ON CONFLICT(key) DO UPDATE SET
  application_id=EXCLUDED.application_id,
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  sensitive=EXCLUDED.sensitive,
  status=EXCLUDED.status,
  updated_at=now();

-- 安全投影一行代表「一个客户生效期间内的一条工作记录」。所有原始客户、部署、
-- 决策轮和周期 ID 都在视图内完成关联，只向 Maintenance 暴露稳定伪名和业务白名单。
CREATE OR REPLACE VIEW maintenance_strategy_work_records_safe
WITH (security_barrier = true)
AS
WITH shared_records AS (
  SELECT
    'WRK-' || upper(substr(md5(period.id || ':' || round.id),1,16)) AS work_record_ref,
    'USR-' || upper(substr(md5(period.customer_id),1,12)) AS user_ref,
    period.strategy_code,
    period.strategy_version_id AS strategy_version,
    period.symbol,
    round.timeframe,
    COALESCE(NULLIF(round.decision_json->>'action',''),'monitoring') AS decision_status,
    round.completeness::text AS completeness,
    period.mode AS execution_mode,
    CASE
      WHEN cycle.id IS NULL AND COALESCE(round.decision_json->>'action','hold')='hold' THEN 'not_required'
      WHEN cycle.id IS NULL THEN 'not_recorded'
      WHEN cycle.status='failed' THEN 'failed'
      WHEN cycle.decision_json->>'riskApproved'='false' THEN 'risk_rejected'
      ELSE 'recorded'
    END AS admission_status,
    COALESCE(counts.order_intent_count,0)::integer AS order_intent_count,
    COALESCE(counts.fill_receipt_count,0)::integer AS fill_receipt_count,
    round.candle_close_time AS occurred_at,
    true AS is_shared_decision,
    false AS real_order_routing_enabled
  FROM strategy_subscription_periods AS period
  JOIN strategy_deployments AS deployment
    ON deployment.id=period.deployment_id
   AND deployment.owner_user_id=period.customer_id
  JOIN strategy_decision_rounds AS round
    ON round.strategy_code=period.strategy_code
   AND round.symbol=period.symbol
   AND round.strategy_version_id=period.strategy_version_id
   AND round.candle_close_time>=period.started_at
   AND (period.ended_at IS NULL OR round.candle_close_time<=period.ended_at)
  LEFT JOIN LATERAL (
    SELECT candidate.id,candidate.status,candidate.decision_json
    FROM strategy_runtime_cycles AS candidate
    WHERE candidate.deployment_id=period.deployment_id
      AND candidate.decision_round_id=round.id
    ORDER BY candidate.completed_at DESC,candidate.id DESC
    LIMIT 1
  ) AS cycle ON true
  LEFT JOIN LATERAL (
    SELECT
      count(DISTINCT intent.id)::integer AS order_intent_count,
      count(receipt.id)::integer AS fill_receipt_count
    FROM official_paper_order_intents AS intent
    LEFT JOIN official_paper_fill_receipts AS receipt ON receipt.intent_id=intent.id
    WHERE intent.runtime_cycle_id=cycle.id
  ) AS counts ON true
), legacy_records AS (
  SELECT
    'WRK-' || upper(substr(md5(period.id || ':' || cycle.id),1,16)) AS work_record_ref,
    'USR-' || upper(substr(md5(period.customer_id),1,12)) AS user_ref,
    period.strategy_code,
    period.strategy_version_id AS strategy_version,
    period.symbol,
    COALESCE(NULLIF(cycle.decision_json->>'timeframe',''),'1h') AS timeframe,
    COALESCE(NULLIF(cycle.decision_json->>'action',''),'monitoring') AS decision_status,
    'legacy'::text AS completeness,
    period.mode AS execution_mode,
    CASE
      WHEN cycle.status='failed' THEN 'failed'
      WHEN cycle.decision_json->>'riskApproved'='false' THEN 'risk_rejected'
      ELSE 'recorded'
    END AS admission_status,
    COALESCE(counts.order_intent_count,0)::integer AS order_intent_count,
    COALESCE(counts.fill_receipt_count,0)::integer AS fill_receipt_count,
    cycle.candle_close_time AS occurred_at,
    false AS is_shared_decision,
    false AS real_order_routing_enabled
  FROM strategy_subscription_periods AS period
  JOIN strategy_deployments AS deployment
    ON deployment.id=period.deployment_id
   AND deployment.owner_user_id=period.customer_id
  JOIN strategy_runtime_cycles AS cycle
    ON cycle.deployment_id=period.deployment_id
   AND cycle.decision_round_id IS NULL
   AND cycle.candle_close_time>=period.started_at
   AND (period.ended_at IS NULL OR cycle.candle_close_time<=period.ended_at)
  LEFT JOIN LATERAL (
    SELECT
      count(DISTINCT intent.id)::integer AS order_intent_count,
      count(receipt.id)::integer AS fill_receipt_count
    FROM official_paper_order_intents AS intent
    LEFT JOIN official_paper_fill_receipts AS receipt ON receipt.intent_id=intent.id
    WHERE intent.runtime_cycle_id=cycle.id
  ) AS counts ON true
)
SELECT * FROM shared_records
UNION ALL
SELECT * FROM legacy_records;

COMMENT ON VIEW maintenance_strategy_work_records_safe IS
  'Security-barrier work-record projection. Excludes raw user/deployment/round/cycle IDs, PII, evidence, model/provider data, errors and credentials.';

REVOKE ALL ON maintenance_strategy_work_records_safe FROM PUBLIC;

-- bootstrap_admin 和现有 Maintenance 技术角色获得独立敏感权限；这里不创建或恢复
-- 用户 assignment，因此应用级撤权墓碑不会被迁移绕过。
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
  'migration-0076-bootstrap-permission-' || md5(role_id || ':' || permission_key),
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

WITH technical_role AS (
  SELECT id
  FROM roles
  WHERE application_id='maintenance'
    AND code='maint_technical'
    AND is_system=true
), synchronized AS (
  INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
  SELECT
    'migration-0076-tech-work-record-export-' || md5(technical_role.id),
    technical_role.id,
    'maint.work_records.export',
    'PLATFORM',
    '[]'::jsonb
  FROM technical_role
  ON CONFLICT(role_id,permission_key) DO UPDATE SET
    scope='PLATFORM',
    scope_organization_ids_json='[]'::jsonb
  RETURNING role_id,permission_key
)
INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json)
SELECT
  'migration-0076-tech-permission-' || md5(role_id || ':' || permission_key),
  NULL,
  'system.technical_role_permission_synchronized',
  'role',
  role_id,
  jsonb_build_object(
    'permissionKey',permission_key,
    'scope','PLATFORM',
    'migration','0076_maintenance_work_record_export'
  )::text
FROM synchronized
ON CONFLICT(id) DO NOTHING;

ALTER TABLE maintenance_idempotency_records
  DROP CONSTRAINT IF EXISTS maintenance_idempotency_records_operation_check;
ALTER TABLE maintenance_idempotency_records
  ADD CONSTRAINT maintenance_idempotency_records_operation_check CHECK (operation IN (
    'maintenance.source_integration.test',
    'maintenance.trading.emergency_stop',
    'maintenance.work_records.export'
  ));
