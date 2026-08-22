# Release Version Management Spec

状态：Approved for implementation
目标版本：`v1.0.0-beta.1`
所有者：Maintenance / Release manager

## 1. 目标

在 Maintenance 应用增加只记录证据、不执行基础设施变更的版本管理控制面。系统以 Git SemVer tag、40 位 commit SHA、构建产物 SHA-256 和 PostgreSQL migration version 组成可核验发布身份，并以追加式记录表达验证、部署、失败和回滚事实。

该功能解决以下问题：

- 当前运行代码、待发布版本和数据库迁移缺少统一可追溯身份。
- staging 与 production 的验证/部署证据分散，无法稳定回答“谁在何时批准并部署了什么”。
- 回滚目标和当前环境版本依赖人工记忆，缺少受权限保护的事实记录。

## 2. 边界

- UI/API 只登记版本、验证证据和部署结果，不执行 SSH、容器切换、数据库迁移、Git tag 或 GitHub Release。
- 真实发布命令仍由 CI/CD 或值班工程师按 Runbook 执行；执行完成后再登记证据。
- 不存储构建日志、访问令牌、私钥、环境变量、Webhook payload 或完整外部响应，只存不可逆摘要、安全 URL 和受限原因。
- 仅 Maintenance audience 可访问；Client 与 Operations 的路由、菜单、API 和数据库角色均不可读取。
- 版本、验证和部署事实只追加，不允许更新或删除。错误事实通过后续记录纠正，不改写历史。

## 3. 角色与权限

| 权限 | 能力 |
|---|---|
| `maint.releases.view` | 查看版本、验证、环境当前版本与部署历史 |
| `maint.releases.manage` | 登记新的不可变版本身份 |
| `maint.releases.approve` | 独立复核版本、登记部署/回滚结果 |

`maint.releases.manage` 与 `maint.releases.approve` 为敏感权限：写请求必须通过 Maintenance session、recent MFA、Origin/CSRF、严格输入、幂等键、reason 和审计策略。版本创建者不能复核自己的版本。

## 4. 状态与规则

版本状态由追加事实投影，不单独可编辑：

```text
draft -> verified -> deployed
   |         |          |
   +-> rejected         +-> superseded
              failed deployment does not change current version
deployed previous version <- rolled_back
```

- `draft`：版本身份已登记，尚无复核决定。
- `verified`：不同用户批准且证据摘要已登记。
- `rejected`：复核拒绝；该版本不可部署。
- `deployed`：至少一个环境存在成功 deploy 事实。
- `superseded`：环境已由后续版本替代；历史仍保留。
- `rolled_back`：后续成功 rollback 事实回到曾在同环境成功部署的版本。

约束：

1. `versionTag` 必须是以 `v` 开头的 SemVer；Beta 首版为 `v1.0.0-beta.1`。
2. `commitSha` 为 40 位小写十六进制；`artifactSha256` 和 `evidenceSha256` 为 64 位小写十六进制。
3. 同一版本标签、commit SHA 和 actor+idempotency key 不可重复创建不同事实。
4. 创建者不可复核；每个版本只有一个最终复核决定。
5. 未通过复核的版本不可登记成功部署。
6. production 成功部署前，同版本必须存在 staging 成功部署事实。
7. rollback 目标必须曾在同一环境成功部署，且不能等于当前版本。
8. `failed` 部署事实只保留失败证据，不改变环境当前版本。
9. 成功事实与审计写入同一数据库事务；并发环境变更使用 PostgreSQL advisory transaction lock 串行化。

## 5. 数据模型

迁移 `0041_release_version_management.sql` 新增：

- `release_versions`：版本标签、channel、commit/artifact/migration 身份、发布说明、创建者与幂等信息。
- `release_verifications`：approve/reject、证据摘要、安全 CI URL、复核者、原因和请求标识。
- `release_deployments`：环境、deploy/rollback、succeeded/failed、前序版本、证据、操作者和原因。

三表均启用禁止 `UPDATE`/`DELETE` 的触发器。应用数据库角色只获得 Maintenance 所需的 `SELECT`/`INSERT`，不授予 Client/Operations。

## 6. API 合同

| 方法与路径 | 权限 | 行为 |
|---|---|---|
| `GET /api/maintenance/releases` | `maint.releases.view` | 游标分页版本、派生状态、环境当前版本和安全运行元数据 |
| `POST /api/maintenance/releases` | `maint.releases.manage` | 幂等登记版本身份 |
| `POST /api/maintenance/releases/{id}/verification` | `maint.releases.approve` | 复核 approve/reject，禁止自审 |
| `POST /api/maintenance/releases/{id}/deployments` | `maint.releases.approve` | 登记 deploy/rollback succeeded/failed 证据 |

错误统一为 `{ error: { code, message, details? }, requestId }`。冲突使用 409，严格输入失败使用 422，无权限使用 403。响应只包含合同 camelCase 字段，不暴露数据库 snake_case、幂等键或内部哈希。

## 7. Maintenance UI

稳定路由 `/releases`，导航名“版本发布”。页面包括：

- 当前 runtime commit/tag 与 staging/production 当前版本，明确区分“进程元数据”和“已登记部署事实”。
- 版本列表、channel、派生状态、commit 短 SHA、迁移版本、创建者、验证和部署时间线。
- 有管理权限时显示登记表单；有批准权限且非创建者时显示复核与部署登记操作。
- 敏感操作使用确认对话框、reason、证据 SHA-256 和结果回执；不得出现“一键部署”或假成功文案。
- loading/error/empty/retry、键盘焦点、`aria-live`、320/768/1024/1440 响应式沿用共享 Console 组件合同。

## 8. 测试与发布 Gate

必须覆盖：

- SemVer/SHA/环境/action/status 输入合同。
- 幂等 replay、并发创建、禁止自审、重复复核、未验证部署、production 缺 staging、失败不改变 current、合法回滚。
- 三表更新/删除失败、数据库角色隔离、Maintenance route/menu/permission 过滤。
- API inventory 对四个 method handler 零遗漏，敏感写策略包含 recent MFA 与 idempotency。
- OpenAPI、API Catalog、ADR、Runbook、CHANGELOG、任务清单同步。
- `npm test`、`npx tsc --noEmit`、`npm run lint`、`npm run test:apps`、`npm run quality:release`、`git diff --check` 全绿。

## 9. 技术约定

- Next.js 16 App Router、React 19、TypeScript strict、PostgreSQL 16；不增加状态库或 UI 框架。
- Route handler 仅负责 session/permission/输入输出；事务状态机放在 service/domain 层。
- 所有 SQL 使用参数化查询；列表使用稳定 `(created_at, id)` 游标。
- UI 使用 `useApiData`、共享 `PageHeading`、`StatusBadge`、`ConfirmActionDialog` 和现有 `rc-*` 样式。
- 实现真源是仓库 Git tag/commit、迁移 registry 与本规格；部署记录不是基础设施执行器。
