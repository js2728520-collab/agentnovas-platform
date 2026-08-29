# T8.2d2a staging/production CI/CD 实例隔离

日期：2026-08-27
状态：工程切片完成；真实 GitHub provider fixture、dispatch/rollback/失陷演练和 G7 仍阻断

## 交付

- provider binding schema 将 `environment` 纳入规范化 material 与 `providerBindingSha256`；staging 和
  production 无法共享同一 binding digest。dispatch preparation 若收到跨环境 snapshot，会在 POST 前拒绝。
- 新增 `0087_restricted_cicd_environment_isolation.sql`。v2 claim、reconciliation 与 expired-dispatch recovery
  gateway 都接收 exact environment；staging 的过期 dispatch 不再阻塞或被 production Worker 恢复，反向同理。
  旧无环境 provider binding 会令升级失败关闭，必须先显式退役，不能被静默解释成任一环境。
- Compose 拆成 `release-orchestrator-staging`、`release-orchestrator-production` 和两份对应 Auditor 服务；每个
  服务使用独立 env/binding/policy/App/attestation/shared-secret source。裸机改用两个 systemd template，并以
  `an-rel-worker-%i`、`an-rel-auditor-%i` 分离 Linux identity。
- 新增只读 instance preflight，核对 Worker/Auditor 的 environment、repository、workflow、control commit、
  runner、environment/runner policy digest。生产配置审计要求同一环境的 Worker/Auditor 成对启停；启用时
  自动执行 preflight。
- target 在加载 binding 与 adapter 后立即核对 environment；不一致时，在连接数据库或监听端口前失败关闭。
- G7 evidence schema 已升级为 v2：11 个 gate 各自绑定统一 subject/provider fixture digest、完整 assertion、
  证据时间窗、artifact hash/bytes 和 `externalWritesEnabled=false`，不再接受只有 `{passed:true}` 的占位文件。
  Auditor environment digest另绑定 exact custom deployment branch policy ID/name。

## 验证

所有重负载验证在 `an-saas` 执行：

- 环境绑定、Worker、Compose/systemd、production audit 定向 47/47；
- instance preflight/audit 定向 11/11；
- PostgreSQL restricted CI/CD/migration 定向 25/25，并包含跨环境过期 dispatch 故障注入；
- fresh PostgreSQL 定向回归 30/30；全量串行测试 1575/1575；
- TypeScript、完整 ESLint 与 8 条架构边界检查通过；
- restricted Compose base + immutable-image override 完整解析。
- Client、Operations、Maintenance 三端 Next.js 16.3.1 production build 全部通过；
- fresh 受控数据库由专用 migrator 应用 88/88 migrations，最小权限模板应用后 role policy 为
  `findings: []`；
- repository secret scan 检查 6435 个 tracked/untracked candidate files，无 finding。

## 外部状态与剩余 Gate

只读检查确认目标 GitHub 仓库当前没有 staging/production environment、ruleset 或 restricted deployment
workflow，仓库 runner 列表又因当前凭证缺少对应 runner read 权限返回 403。因此现在不能生成真实 provider
fixture，也不能把本切片称为 G7。用户已允许在 `an-saas` 使用三个测试域名进行后续构建、测试和替换，但本切片
收口时尚未创建/修改 GitHub settings、推送 workflow/control tag、dispatch、启动 release 服务或切换测试域名。

所有 release 开关继续为 `false`；未提交、推送、创建 PR、dispatch、替换 DNS/测试域名或接触 production。
