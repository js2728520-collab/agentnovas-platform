# ADR-0023：双重验证能力保留与生产启用门禁

状态：Accepted

日期：2026-08-23

关联：ADR-0011、ADR-0021、G1、G8

## 背景

三端已经具备 TOTP、恢复码、加密凭证、登录挑战、recent MFA 与审计能力。需求方确认：
准备和升级阶段先不强制双重验证，正式投入生产使用后再开启。删除相关实现会制造二次开发和
数据迁移风险，而继续默认强制会阻碍现阶段账号注册、验收和运营协作。

## 决策

1. 使用服务端环境变量 `MFA_ENFORCEMENT_ENABLED` 控制强制策略；只有精确值 `true` 才开启，
   缺失、空值或其他值均按关闭处理。
2. 当前三端环境模板和自动浏览器验收显式设置为 `false`。关闭时登录直接创建完整 audience
   Session，内部敏感权限不要求 recent MFA，内部密码重置不创建 primary-only 半登录会话。
3. TOTP/recovery 数据表、AES-GCM 加密、绑定/验证/轮换 API、审计和页面状态全部保留。Client
   可预先绑定；内部恢复码轮换在关闭期间不开放，避免出现无法取得 recent MFA 的死路径。
4. 权限链接注册返回当前策略事实：关闭时不要求首次登录绑定 MFA，不改变链接冻结的角色、
   scope、限流、撤销、审计或 Session 安全。
5. 正式生产启用必须在 Client、Operations、Maintenance 同一发布中全部设为 `true`，重启三端，
   并通过登录、首次绑定、已绑定验证、恢复码、recent MFA、密码重置和回滚浏览器 Gate。
6. 本开关不关闭邮箱验证、密码强度、登录限流、Audience/Cookie 隔离、五设备上限、Session
   撤销、权限校验、Origin/CSRF、幂等或 maker-checker。

## 生产启用与回滚

- 启用前确认三端使用可解密既有凭证的 `MFA_TOTP_ENCRYPTION_KEY`，并准备丢失验证器恢复流程。
- 将三端 `MFA_ENFORCEMENT_ENABLED=true` 后执行 G1/G8 MFA 专项；任一端失败不得切流。
- 回滚只将三端同时改回 `false` 并重启，不删除凭证、恢复码或审计记录，不需要数据库迁移。

## 后果

- 当前阶段的“已绑定”不等于“登录时已强制”，UI、API 和文档必须同时展示 enforcement 状态。
- G1 可以记录 MFA 能力测试已通过，但正式生产 Gate 在开关为 `true` 的目标环境复验前不得通过。
- 安全审查必须把开关误配监控、三端状态一致性和生产变更审批纳入发布检查。

## 本地实施证据（2026-08-24）

- 当前默认关闭态隔离浏览器 18/18 通过；扩展开启态 3/3 覆盖三端绑定/验证、TOTP、恢复码、
  Client/Operations 密码重置、旧会话撤销和 recent MFA 过期拒绝。
- `test:e2e:mfa-rollout` 在同一一次性 PostgreSQL schema 上依次重启三端为
  `true → false → true`，9 条旅程证明关闭期可直接登录、重新开启后关闭期 Session 不能绕过
  MFA、三份既有凭据保持 active 并可重新完成挑战。
- 演练发现并由前向迁移 0072 修复 Client 密码重置网关的 PL/pgSQL 输出列名歧义；完整迁移链
  回归同时验证密码更新、token 消耗和审计链写入。该证据不替代目标生产环境的三端同步变更。
