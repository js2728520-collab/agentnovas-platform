-- Customer PII is split into explicit field categories. Merely holding
-- ops.customers.view never reveals plaintext contact, login, financial, or
-- exchange-account data. All five permissions are sensitive so that enabling
-- MFA enforcement later automatically adds the recent-MFA gate.
INSERT INTO "permission_definitions" ("key", "application_id", "label", "sensitive", "status")
VALUES
  ('ops.customers.pii_contact', 'operations', '查看客户完整联系方式', true, 'active'),
  ('ops.customers.pii_security', 'operations', '查看客户登录与设备信息', true, 'active'),
  ('ops.customers.pii_financial', 'operations', '查看客户累计充值与消费', true, 'active'),
  ('ops.customers.pii_trading', 'operations', '查看客户交易所账户与持仓', true, 'active'),
  ('ops.customers.export', 'operations', '导出客户数据', true, 'active')
ON CONFLICT ("key") DO UPDATE
  SET "application_id" = EXCLUDED."application_id",
      "label" = EXCLUDED."label",
      "sensitive" = EXCLUDED."sensitive",
      "status" = EXCLUDED."status";
