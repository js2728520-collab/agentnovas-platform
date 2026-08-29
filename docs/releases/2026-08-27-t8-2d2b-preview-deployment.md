# T8.2d2b 三域 preview 安全替换

日期：2026-08-27
状态：`PREVIEW_WEB_PASS / G7_HOLD`

## 范围与身份

- 仅替换 `an-saas` 上的 Web-only preview：
  `test.agentnovas.com`、`ops-test.agentnovas.com`、`main-test.agentnovas.com`；
  未触碰 3100/3101/3102 的 beta.6 环境或 production。
- Release：`preview-7c047b6-wt-20260827T013000Z`。候选来自未提交 worktree，不能登记为正式 release。
- Source tree SHA-256：`5c924295317bcd0b6dc1e7d865510d4c49a238db02aa8298627ae9ea5e10d844`。
- Artifact SHA-256：`37aeecae12d72a483de83cb3b5acd5d8a33744c010b7f325c3c6262a50897a22`。
- Client/Operations/Maintenance image ID 分别为
  `sha256:083ed71c…b757`、`sha256:728662b4…a461`、`sha256:66153842…120e`。

## 数据库与回滚

- 替换前保存 PostgreSQL custom-format backup，754152 bytes，SHA-256
  `39226c48118ca06d8dc7f42c38815705393c0da3b09347c4909109130cc3fe07`；`pg_restore --list` 验证可读。
- 新增 `container-postgres-backup-gate.mjs`，以专用 migrator、`--enable-row-security`、exclusive
  create/`0600`、流式 `pg_dump`、只读 TOC verification 和 SHA-256 固化容器备份入口；两个容器发布门禁
  在 Node 22.21.1 下合计 10/10。
  对运行中 preview 再次真实备份为 1175131 bytes，SHA-256
  `7bc93482dfc811f38b0e949e31309a7b7fae351ce2ccd22ac78a4d06ab6c642e`，`tocVerified: true`。
- preview 从 0076 追加到当前 88 个 migration；执行结果为 11 applied、77 skipped。
  registry 共 89 行，唯一额外历史项为已退役名称
  `0068_internal_registration_role_guard_owner.sql`，当前 migration 无缺失。
- 应用最小权限模板后，loopback role policy 返回 `findings: []`。
- 新增 `container-postgres-role-policy-gate.mjs`，以非 shell Docker 参数、只读 env mount 和数据库容器
  network namespace 固化同一校验；Node 22.21.1 单测 5/5，随后对运行中 preview 实例返回
  `{"database":"agentnovas","findings":[]}`。宿主机参数和证据均不含数据库 URL。
- 最终在全新 PostgreSQL 16.14 Bookworm 数据卷上串行全量 1585/1585；TypeScript、完整 ESLint、8/8 架构边界
  均通过。临时容器及匿名 volume 已删除。最终 secret scan 覆盖 6448 个 candidate files，无 finding。
- 替换前保存三端旧 image ID；Compose/健康检查失败会自动恢复旧镜像。实际未触发回滚。

## 发布后验证

- 三端容器全部 `healthy`、restart=0、启动日志 error marker=0。
- loopback 与公网的 `/`、`/api/health/live`、`/api/health/ready` 全部 200；错误 Host 全部 404。
- Client 请求 Maintenance、Operations 请求 Client、Maintenance 请求 Operations 路由均 404；
  Maintenance 自有 release-workflow 路由匿名访问为 401，证明路由存在且受认证保护。
- 10 轮、45 秒稳定性采样：30/30 容器状态 healthy/restart=0，30/30 公网 ready=200。
- 隔离 Playwright Chromium 检查三域：每页 200、可见 body、1 个 h1、0 console warning/error、
  0 pageerror、0 request failure、0 5xx；截图人工核对无断裂、遮挡或错误页。
- 安装并审计 preview default-off 配置：`core_configuration=ready`；Resend、UDUN 仍 incomplete，
  Email send、Notification/Runtime/Demo/Configuration Activation 及全部 Restricted CI/CD 进程仍 disabled。
- 运行中的 Release Worker/Auditor/Webhook/Target/Control/Identity Verifier 数量为 0。

## 证据

- `http-smoke.log`：`74f2eac7e1b29e598099b2f59091d1016b1eb4773712e584be8ba667c786ec93`
- `runtime-security-smoke.log`：`9be201f2009ffb0cde610f6d0d0e677078cfe39e5886ecbbb30bb5a220e88e37`
- `stability-sample.log`：`99a3c828eeb71ce6adf98a7e7022e5314587fd7a7676bed0e5eec3ac492a1d71`
- `browser-smoke.json`：`7d12c45cf3de7fafb8c063af7964470da5687ef43a303cf2faebc5e032618c77`
- `config-audit-installed.log`：`42933a864724315ffe73d65b8a85b836fc61a573be102fd19e2f45cc8e151318`
- `role-policy.log`：`23e1445af2cc6f5b32602a1b221cf2b28f99f7347d21b75ef8bbf9800b52ec88`
- `container-role-policy-gate.log`：`c2a5ab86a88fc46c95e024a706e841e991a09aa61fa959772943738674b618f2`
- `container-role-policy-quality.log`：`bead35f3c08713b0b82e1c080743952f3d7c2b1b59a91fa103ae124a34a2717b`
- `container-role-policy-secret-scan.log`：`6015e87988d44edf5a1f285511d64ff06dda1d99d9d87fae2cc9e265d2ddd085`
- `container-postgres-backup-gate.log`：`dd5b621524a10e6cb4827bbe02e5bed0962bb99c9d98e88784bd01dbc0a3c1f4`
- `preview-post-gates-20260827T023000Z.dump`：`7bc93482dfc811f38b0e949e31309a7b7fae351ce2ccd22ac78a4d06ab6c642e`
- `container-release-gates-quality.log`：`55547621aa3ecfb9e204781effd7dfac2d3c4689546d3f72c97a35c5850af004`
- `container-release-gates-secret-scan.log`：`1887d9bcf670d87ca499d57b13d387d45c527ea6f466a8cd8625564bcb362210`
- `migration.log`：`d28e3a96684265c9a7f3ce2c0aa1f9b13d69929dd997259beaa4c066e45f5de7`

以上文件和匿名截图保存在
`/opt/agentnovas-riverton-preview/releases/preview-7c047b6-wt-20260827T013000Z/`。

## 保持阻断

- 本轮没有 GitHub settings、push、tag、PR、workflow dispatch 或真实 provider 调用。
- 没有启动任何后台 Worker 或外部写入；真实订单路由仍不在范围内。
- GitHub environment/ruleset/runner fixture、staging dispatch/rollback/失陷演练和双人 G7 仍未完成，
  所以状态只能是 `PREVIEW_WEB_PASS / G7_HOLD`。
