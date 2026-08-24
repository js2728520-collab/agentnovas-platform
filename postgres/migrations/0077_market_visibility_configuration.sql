-- 市场可见性配置族（T2.1c 收口）。
--
-- P-03 要求六个股票市场的可见性由运维端控制。可见性不是功能开关：它决定客户能不能
-- 看到某个市场，改错会直接对外露出未授权或未就绪的行情，因此走版本化配置的完整
-- draft/test/approve/schedule/activate/rollback 流程，而不是一个即时生效的布尔值。
--
-- 单独加 kind='market' 而不是塞进 feature_flag：两者的 schema、测试器与消费者都不同，
-- 混用会让「功能开关的确定性测试」被误当成「市场可见性已验证」。

ALTER TABLE configuration_versions
  DROP CONSTRAINT IF EXISTS configuration_versions_kind_check;

ALTER TABLE configuration_versions
  ADD CONSTRAINT configuration_versions_kind_check
  CHECK (kind IN ('brand','domain','protocol','feature_flag','prompt','skill','pricing','market'));

-- 运维端读取当前生效可见性的最小权限网关。
--
-- 和 0071 的 feature flag current 网关同一形状：Web 角色不获得配置底表读权限，只能
-- 通过这个函数拿到「已激活版本的 payload」。底表里有草稿、未批准版本和审批意见，
-- 那些不该出现在任何运行时读路径上。
CREATE OR REPLACE FUNCTION market_visibility_current(
  p_configuration_key text
) RETURNS TABLE(
  configuration_version_id text,
  schema_version integer,
  payload_json jsonb,
  payload_sha256 text
) AS $$
  SELECT version.id,version.schema_version,version.payload_json,version.payload_sha256
    FROM configuration_activations AS activation
    JOIN configuration_versions AS version ON version.id=activation.configuration_version_id
   WHERE version.kind='market'
     AND version.configuration_key=p_configuration_key
     AND version.audience='shared'
   ORDER BY activation.sequence_no DESC
   LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT;

COMMENT ON FUNCTION market_visibility_current(text) IS
  'Least-privilege projection of the active market visibility configuration. Returns the payload digest so consumers can re-verify it. Web roles read this instead of the configuration tables, which also hold drafts and approval notes.';

REVOKE ALL ON FUNCTION market_visibility_current(text) FROM PUBLIC;

DO $$
BEGIN
  -- 三端都要读可见性：Client 决定展示哪些市场，内部端要能看到同一事实以便排查。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT EXECUTE ON FUNCTION market_visibility_current(text) TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT EXECUTE ON FUNCTION market_visibility_current(text) TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT EXECUTE ON FUNCTION market_visibility_current(text) TO agentnovas_maint_web;
  END IF;
  -- Runtime Worker 也要读：陈旧或被下架的市场不应继续驱动决策轮。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_runtime_worker') THEN
    GRANT EXECUTE ON FUNCTION market_visibility_current(text) TO agentnovas_runtime_worker;
  END IF;
END $$;
