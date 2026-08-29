# T8.2c 默认关闭的 Maintenance 受限 CI/CD 控制面

日期：2026-08-27

状态：完成；仅放行 T8.2d/G7，运行时、workflow、真实 credential 和生产启用仍阻断。

## 交付

- `/releases` 增加请求、审批、activation、stop/clear 的内联工作台与十条严格 Maintenance API route；actor、
  permission、recent MFA、request/idempotency 均由服务端和数据库绑定，浏览器不能传 repository、workflow、
  ref、shell、SSH、SQL 或基础设施凭证。
- Maintenance Web 不持有 release-control 或 identity-verifier DSN。它先用自己的最小角色签发只绑定一次动作的
  opaque authority，再以不同 HTTP secret 顺序调用 verifier 和 control。
- `release-identity-verifier` 单独验证 WebAuthn challenge、RP、origin、UV、signature 与 counter，只收到
  authority/mutation document/assertion，不接收 raw session，也不能执行 mutation。
- `release-control` 不持有 WebAuthn policy 或 credential key，只能把 assertion ID、mutation digest 与原始
  Maintenance envelope 交给单一数据库执行 gateway；所有裸 mutation gateway 对它保持撤权。
- `0084_restricted_cicd_maintenance_control.sql` 以 RLS/追加事实记录 authority、assertion 和 consumption，在同一
  transaction 内重算 digest、锁定和消费 assertion，再执行精确 mutation。verifier 响应丢失、control 响应
  丢失及已消费结果跨 TTL 重试都返回相同事实，不能二次执行；A 用户签名不能替换到 B session。
- 两个服务仅加入 Compose `restricted-cicd` profile，backplane-only、无 published port、read-only/cap-drop、
  默认关闭。systemd 是旧迁移参考，不添加这两个服务的半成品 unit。

## 安全复审

fresh-context 对抗复核关闭跨 actor/session、WebAuthn 响应丢失、control 响应丢失、TTL 后重放和部署边界问题。
最终没有剩余 Critical/High。真实 perpetual order routing 仍关闭；本切片没有引入 Cloudflare Runtime 或 Redis。

## 验证证据

所有重型验证均在 `ssh an-saas` 隔离临时工作区执行：

- Node.js 22.21.1、PostgreSQL 16.14 fresh 数据库：85 个迁移 applied，幂等 registry 完整；least-privilege roles
  与 role policy `findings=[]`。
- source/contract/security 扩展套件 118/118；PostgreSQL 控制 7/7、迁移链 1/1、领域事实 13/13、Worker
  恢复 3/3，总计 24/24。
- TypeScript `--noEmit --incremental false`、ESLint `--quiet`、Maintenance Next.js 16.3.1 production build、
  `docker compose --profile restricted-cicd config --no-interpolate` 全部通过。
- 官方 `mcr.microsoft.com/playwright:v1.62.1-noble` production Chromium 4/4，通过 320/768/1024/1440、axe、
  键盘、audience、console/network 和零确认弹窗门禁。

第一次 production build 因远端临时目录中旧 `.next-maintenance/trace` 的所有者导致 `EACCES`；只清理该受控
临时 build cache 后重建通过，属于临时环境残留，不是仓库代码失败。一次扩展数据库套件也曾因测试 URL 未
显式用户名在 PostgreSQL startup packet 前失败，改用隔离容器的 `postgres` 测试角色后全部通过。

## 未执行

未提交、推送、创建 PR、dispatch、配置真实 secret、启动 release 服务、替换 preview/DNS 或接触 production。
`test.agentnovas.com`、`ops-test.agentnovas.com`、`main-test.agentnovas.com` 保持未变。

## 下一切片

T8.2d/G7 必须交付专用 immutable workflow、environment/runner fixture、backup retention、实际 restore
rehearsal 的版本与 `verified_at`、target manifest schema compatibility、staging/production/rollback 与控制面
失陷演练，以及绑定日志 SHA-256/审批人的不可变 G7 evidence manifest。G7 代码证据通过后仍需要用户明确
授权首次 production activation。
