# ADR-0014：不可变版本与发布证据控制面

状态：Accepted
日期：2026-08-21

## 背景

三端构建、Git commit、迁移 registry、CI Gate 和环境切换已有各自证据，但缺少一个受 Maintenance RBAC 保护的统一事实视图。直接从网页执行 SSH、迁移或切流会扩大控制面权限，也会把部署编排与业务应用耦合。

## 决策

1. Git SemVer tag、40 位 commit SHA、构建产物 SHA-256 和 migration version 共同构成发布身份。
2. `release_versions`、`release_verifications`、`release_deployments` 只追加，数据库触发器禁止更新/删除。
3. 版本创建与验证采用不同人员；敏感写请求要求 Maintenance 显式权限、recent MFA、Origin、幂等键、原因和审计。
4. production 成功部署事实必须以前置的同版本 staging 成功事实为条件；失败事实不改变环境 current 投影。
5. 回滚目标必须曾在同环境成功部署。current 版本始终由最新成功事实投影，不保存可被任意覆盖的状态字段。
6. Maintenance `/releases` 只登记 CI/CD 或值班人员已经产生的证据，不执行 Git tag、SSH、迁移、切流或回滚。
7. Client/Operations 数据库角色和页面均不能读取发布表；Maintenance 只有 `SELECT`/`INSERT`，没有 `UPDATE`/`DELETE`。

## 后果

- 能稳定回答版本身份、独立验证、环境 current、失败尝试和回滚目标，同时保留完整历史。
- 登记事实不能替代真实部署验证；错误登记必须用后续事实和事故记录纠正。
- 部署系统仍需安全地注入 release tag、commit 和 artifact digest，发布人员按 Runbook 完成外部执行。
- 若未来接入自动部署，只能由独立 machine identity 消费已批准版本；不得复用浏览器 session 或放宽当前 API。
