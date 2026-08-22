-- 播种 ops.trading.manage。
--
-- 这个权限键被四条运维路由使用（熔断开关的挂起/解除、实盘路由的申请/批准/撤销），
-- 但从未登记进 permission_definitions。后果不是越权而是**安全刹车不可达**：
-- lib/access-control.ts 对未注册的权限键抛 PERMISSION_UNKNOWN 500，于是事故中
-- 运营根本挂不上熔断。
--
-- 更隐蔽的是导航项也用这个键做可见性判断，没有任何角色持有它 ⇒ 两个界面入口
-- 在 UI 上永久隐藏，运营不会发现它坏了。
--
-- 标记 sensitive：它能停掉全平台新开仓，也能批准真实下单，必须走近期 MFA。

INSERT INTO "permission_definitions" ("key", "application_id", "label", "sensitive", "status")
VALUES ('ops.trading.manage', 'operations', '管理交易熔断与实盘路由', true, 'active')
ON CONFLICT ("key") DO UPDATE
  SET "application_id" = EXCLUDED."application_id",
      "label" = EXCLUDED."label",
      "sensitive" = EXCLUDED."sensitive",
      "status" = EXCLUDED."status";
