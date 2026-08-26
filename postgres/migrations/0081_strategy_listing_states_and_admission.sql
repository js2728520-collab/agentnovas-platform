-- 策略广场上架状态机与准入门槛（T4.2 / P-05）。
--
-- 此前 community_strategies.status 是一列自由文本，合法迁移散落在六个路由文件的
-- `.includes()` 判断里。后果不只是难维护：`submitted` 实际是死胡同——投稿会创建一张
-- `strategy_listing` 审批单，而唯一的审批端点明确拒绝该类型（「该遗留审批类型在商用
-- Paper 版本中已停用」），于是没有任何路径能让策略走到 approved；广场列表查的却是
-- 上架态。整个策略广场因此从未真正跑通过。

-- 状态改名：published → listed，paused → delisted。
--
-- `paused` 是真正的语义错误，不只是命名：自动下架与作者下架都写 `paused`，而 paused
-- 在别处（订阅、部署）表示「可恢复的暂停」。下架不可恢复——重新上架必须走新版本重新
-- 审核。两个不同的概念共用一个词，读代码的人无从分辨。
UPDATE community_strategies SET status = 'listed' WHERE status = 'published';
UPDATE community_strategies SET status = 'delisted' WHERE status = 'paused';

-- 兜底：库里若还有其它历史值，归入 draft 而不是留着违反约束。
-- draft 是最保守的落点——它不对客户可见，也不声称通过了任何审核。
UPDATE community_strategies
   SET status = 'draft'
 WHERE status NOT IN ('draft','testing','submitted','under_review','approved','listed','delisted','rejected');

ALTER TABLE community_strategies DROP CONSTRAINT IF EXISTS community_strategies_status_check;
ALTER TABLE community_strategies
  ADD CONSTRAINT community_strategies_status_check CHECK (status IN (
    'draft','testing','submitted','under_review','approved','listed','delisted','rejected'
  ));

CREATE INDEX IF NOT EXISTS idx_community_strategies_listed
  ON community_strategies (status, ranking_score DESC)
  WHERE status = 'listed';

-- 准入判定的证据。
--
-- PRD 6.5：「不得用口头结论替代」。因此每次投稿都要落下一条判定记录：依据哪份回测、
-- 按哪个档位的门槛、逐项结果如何。审核人看到的是哪几条不达标，而不是一个布尔。
CREATE TABLE IF NOT EXISTS strategy_admission_evaluations (
  id text PRIMARY KEY,
  strategy_id text NOT NULL REFERENCES community_strategies(id) ON DELETE CASCADE,
  strategy_version integer NOT NULL,
  -- 依据的那份回测。判定与回测一一对应，换了回测就是另一次判定。
  validation_id text NOT NULL REFERENCES strategy_validations(id) ON DELETE RESTRICT,
  risk_tier text NOT NULL CHECK (risk_tier IN ('conservative','balanced','aggressive')),
  meets_thresholds boolean NOT NULL,
  checks_json jsonb NOT NULL CHECK (jsonb_typeof(checks_json) = 'array'),
  -- 判定时生效的门槛版本（与 PS-05 同一模式）。门槛改了不影响已经做过的判定，否则
  -- 「这次投稿当初按什么标准过的」会得到一个随时间变化的答案。
  thresholds_configuration_version_id text REFERENCES configuration_versions(id) ON DELETE RESTRICT,
  thresholds_payload_sha256 text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  -- 每个 (策略, 版本) 一条判定。重新提交同一版本必须落在同一行上。
  UNIQUE (strategy_id, strategy_version),
  CONSTRAINT strategy_admission_evaluations_thresholds_pin_check CHECK (
    (thresholds_configuration_version_id IS NULL AND thresholds_payload_sha256 IS NULL)
    OR (thresholds_configuration_version_id IS NOT NULL
        AND thresholds_payload_sha256 ~ '^[a-f0-9]{64}$')
  )
);

COMMENT ON TABLE strategy_admission_evaluations IS
  'Deterministic strategy admission evaluation recorded at submission (P-05). Empty threshold pin columns mean the code-default thresholds were used, not that they are unknown.';

-- 门槛可由运维调整（P-05 operatorConfigurableThresholds），因此走版本化配置。
--
-- 单独加 kind 而不是塞进 feature_flag 或 pricing：schema、测试器与消费者都不同，混用
-- 会让「功能开关的确定性测试」被误当成「准入门槛已验证」。
ALTER TABLE configuration_versions
  DROP CONSTRAINT IF EXISTS configuration_versions_kind_check;

ALTER TABLE configuration_versions
  ADD CONSTRAINT configuration_versions_kind_check
  CHECK (kind IN ('brand','domain','protocol','feature_flag','prompt','skill','pricing','market','strategy_admission'));

CREATE OR REPLACE FUNCTION strategy_admission_current(
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
   WHERE version.kind='strategy_admission'
     AND version.configuration_key=p_configuration_key
     AND version.audience='shared'
   ORDER BY activation.sequence_no DESC
   LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT;

COMMENT ON FUNCTION strategy_admission_current(text) IS
  'Least-privilege projection of the active strategy admission thresholds. Web roles read this instead of the configuration tables, which also hold drafts and approval notes.';

REVOKE ALL ON FUNCTION strategy_admission_current(text) FROM PUBLIC;

DO $$
BEGIN
  -- Client 在投稿时判定；运营端审核时要看到同一份门槛。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT EXECUTE ON FUNCTION strategy_admission_current(text) TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT EXECUTE ON FUNCTION strategy_admission_current(text) TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT EXECUTE ON FUNCTION strategy_admission_current(text) TO agentnovas_maint_web;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_client_web') THEN
    GRANT SELECT, INSERT, UPDATE ON strategy_admission_evaluations TO agentnovas_client_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_ops_web') THEN
    GRANT SELECT ON strategy_admission_evaluations TO agentnovas_ops_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentnovas_maint_web') THEN
    GRANT SELECT ON strategy_admission_evaluations TO agentnovas_maint_web;
  END IF;
END $$;

-- 上架审核权限。
--
-- 与 `ops.approvals.decide` 分开：那条覆盖的是汇报关系变更这类内部事务，而上架审核决定
-- 的是哪些策略能被客户跟随并投入真实资金。把两者合成一条，等于让任何能处理内部审批的
-- 人顺带获得放行策略上架的权限。
INSERT INTO "permission_definitions" ("key", "application_id", "label", "sensitive", "status")
VALUES
  ('ops.strategy_listing.view', 'operations', '查看策略上架审核', false, 'active'),
  ('ops.strategy_listing.review', 'operations', '审核策略上架', true, 'active')
ON CONFLICT ("key") DO UPDATE
  SET "application_id" = EXCLUDED."application_id",
      "label" = EXCLUDED."label",
      "sensitive" = EXCLUDED."sensitive",
      "status" = EXCLUDED."status";

-- 记录是谁认领了审核。没有这一列，under_review 只是个状态名，说不出「谁在审」。
ALTER TABLE community_strategies
  ADD COLUMN IF NOT EXISTS review_claimed_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS listed_at timestamptz,
  ADD COLUMN IF NOT EXISTS delisted_at timestamptz;
