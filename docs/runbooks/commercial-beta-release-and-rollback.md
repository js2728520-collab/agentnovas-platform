# Riverton Capital 付费 Beta 发布与回滚 Runbook

当前发布方式为 `deploy/container/compose.yml` 的版本化容器；`deploy/systemd/` 与 `deploy/nginx/` 只保留为旧环境迁移参考，新安装不得同时启动两套 Web/Worker。容器发布仍遵守本文件的数据库、角色、证据和外部副作用 Gate。

## 1. 发布前

- 核对 commit、artifact hash、Node/PostgreSQL 版本、migration checksums 和所有 Gate 证据。
- 检查 `.env`、密钥、密码、私钥、数据库备份、日志、截图、trace 和 fixture 未进入 Git/artifact。
- 三端/Workers/migrator 使用独立最小 env/DB role；Payment Worker disabled。Demo Worker 的 `DEMO_EXECUTION_WORKER_ENABLED` 与 `PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED` 分离管理，进程存活不等于已授权向 provider 写入。
- 从 `deploy/env/*.env.example` 分别生成 `/etc/agentnovas/client.env`、`operations.env`、`maintenance.env`、`notification.env`、`demo.env`、`runtime.env`、`migrator.env`；权限不得高于 `0640`，禁止重新合并成共享密钥文件。`deploy/agentnovas.env.example` 已退役，不能作为进程环境模板。
- 仓库不再提供旧 `agentnovas-web.service`、Payment Worker unit 或旧单端 Nginx 配置；只安装 `deploy/systemd/` 当前 units 与 `deploy/nginx/riverton-three-apps.conf`。
- `systemd-analyze verify`、`nginx -t`、端口/server name/Cookie/Host/TLS/CSP smoke 通过。
- 备份恢复、fresh/N-1 migration、current/previous 应用回滚演练完成。
- 生成聚合发布制品后记录 `RIVERTON_RELEASE_TAG`、`GIT_COMMIT_SHA` 和 `RIVERTON_ARTIFACT_SHA256`；值必须来自同一 Git/tag 与最终制品，禁止手工猜测或使用工作区未提交内容。

### 1.1 最小数据库角色

Fresh 数据库先由管理员只建立 migrator；升级库可先验证既有 migrator。口令通过交互式安全渠道另行设置，不写入 SQL、命令历史或仓库：

```bash
psql "$ADMIN_DATABASE_URL" \
  --set=agentnovas_database=agentnovas \
  --file=deploy/postgres/bootstrap-migrator.sql
```

设置 migrator 口令并用其执行全部 checksum migration 后，再由管理员在单个事务中收敛完整发布角色与 ACL：

```bash
psql "$ADMIN_DATABASE_URL" \
  --set=agentnovas_database=agentnovas \
  --file=deploy/postgres/least-privilege-roles.sql

RELEASE_ROLE_POLICY_DATABASE_URL=postgresql://agentnovas_migrator@127.0.0.1/agentnovas \
node scripts/release/postgres-role-policy.mjs
```

校验结果必须为 `findings: []`。Client/Operations 无 Maintenance 密钥表权限；Notification、Demo、Runtime Worker 只能访问各自允许清单；Payment/legacy Research 角色必须为 `NOLOGIN` 且无表权限。应用进程不得使用 migrator 或管理员连接串。Client 的 `DATABASE_URL` 必须为 `agentnovas_client_web`，`CLIENT_AUTH_DATABASE_URL` 必须为独立的 `agentnovas_client_auth`；后者只能执行精确登录身份投影，不能读表、创建会话或继承 Web 角色。

`0040_client_identity_rls.sql` 与 `0043_client_identity_gateway_hardening.sql` 应用后，角色校验还会确认 `users`、`sessions`、`auth_tokens` 与两张 MFA 表已启用强制限制性 RLS、所有者为 `agentnovas_migrator`，策略的 USING/WITH CHECK、policy roles 和完整角色 allowlist 均匹配。Client 连接必须始终显示 `current_user = agentnovas_client_web`；不得通过连接池 GUC、请求 Header 或 JWT 切换数据库身份。Client Web/Auth 均无身份与邀请表直访，只能经各自精确 gateway 处理登录投影或当前有效 session 绑定的主体；Operations/Maintenance 使用各自连接角色。邀请注册读取内部汇报链只能调用 `client_registration_attribution(text,text)`，不得恢复 Client 对内部 `users` 行的可见性。

若登录、注册、MFA 或会话撤销在上线后返回 PostgreSQL `42501`，先停止 Client 切流，核对 migration registry 中 `0040`、`0043`，重新执行本节最小角色模板并运行 role policy；禁止临时关闭 RLS 或把 Client 改用 migrator/内部端连接串。修复后依次复测客户登录、邀请码注册、密码找回、MFA 启用/验证/恢复码轮换、其他设备会话撤销。用 Client Web 角色直查五张身份表、邀请表或调用 `client_login_identity` 必须得到 `42501`；用 Client Auth 角色调用 `client_complete_login` 也必须得到 `42501`。过期但未显式 revoked 的会话哈希不能调用任何 self gateway。

### 1.2 本机隔离恢复演练

恢复演练脚本具有四道限制：显式 `--execute`、`RELEASE_REHEARSAL_ALLOW_LOCAL=1`、loopback 且受控命名的源库、源库与管理连接均使用专用 `agentnovas_migrator`。专用角色要求保证启用 FORCE RLS 后仍能读取迁移证据，并使还原对象保持正确所有者；本地演练期间可临时授予该角色 `CREATEDB`，结束后必须立即撤销。脚本创建一次性目标库，使用非 shell 的 `pg_dump/createdb/pg_restore/dropdb`，逐表核对行数与 migration checksum，最后自动删除目标库和临时目录：

```bash
RELEASE_REHEARSAL_ALLOW_LOCAL=1 \
RELEASE_REHEARSAL_SOURCE_DATABASE_URL=postgresql://agentnovas_migrator@127.0.0.1/agentnovas_recovery_source_release1 \
RELEASE_REHEARSAL_ADMIN_DATABASE_URL=postgresql://agentnovas_migrator@127.0.0.1/postgres \
node scripts/release/postgres-recovery-rehearsal.mjs --execute
```

源库必须是专门准备的本机演练副本，不得把生产地址、远端主机或生产管理员口令传给脚本。输出必须为 `status: verified`，表集合、逐表行数和 migration registry 完全一致，并确认一次性目标库已清理。

### 1.3 版本身份与验证

1. 用 `git rev-parse HEAD` 得到完整 40 位 commit，用 `git describe --tags --exact-match` 验证 SemVer tag；没有准确 tag 时只能登记候选版本，不能宣称已发布。
2. 对最终不可修改的聚合制品执行受控 SHA-256 工具并保存摘要。三端若分成独立制品，应先生成包含三项摘要的 manifest，再把 manifest SHA-256 作为平台 artifact identity。
3. Maintenance maker 在 `/releases` 登记 tag、commit、artifact、最新 migration 和发布说明。系统只创建 `draft`，不执行 Git 或服务器操作。
4. 不同 Maintenance checker 核对远端 CI、测试证据和摘要后 approve/reject；创建者不能自审。
5. 将三个安全元数据注入 `/etc/agentnovas/maintenance.env` 后重启 Maintenance；页面 runtime 元数据只用于比对，不替代环境部署事实。

发布记录不得包含 token、密钥、环境变量正文、构建日志、Webhook payload 或数据库备份。CI run URL 只允许当前 GitHub Actions 的 HTTPS run；其他证据先归档到受控证据系统，再登记其 SHA-256。

### 1.4 容器构建与制品清单

首个 Beta 为 `v1.0.0-beta.1`。后续按 SemVer 提升版本，禁止覆盖已存在的 tag 或镜像，禁止构建/部署 `latest`。先验证发布身份：

```bash
RIVERTON_RELEASE_TAG='vX.Y.Z' # 执行前替换为尚未使用的新 SemVer
npm run release:identity -- "$RIVERTON_RELEASE_TAG"
```

从 `v1.0.0-beta.4` 起，`scripts/release/build-container-images.mjs` 已通过合同测试固定使用 `deploy/container/Dockerfile`。批准的构建路径为：

1. 首选推送新的 annotated tag，由 `.github/workflows/container-release.yml` 生成四张 GHCR 镜像、SBOM、provenance 和 digest；
2. 目标服务器没有 Registry 只读凭证时，从精确 tag/commit 的干净 checkout 执行 `npm run release:build-images -- vX.Y.Z`，逐张构建、inspect 并生成 manifest；不得改用工作区或手写 `latest` 镜像。

manifest 包含完整 commit、最新 migration、平台、四张镜像 ID/digest 与聚合 `artifactSha256`。三端镜像必须来自同一次提交；不得把工作区临时构建登记为发布制品。后续修复 helper 后，应恢复单一受测命令并同步删除本临时限制。

目标服务器没有 Registry 凭证时，优先使用受控传输交付同一个 Docker archive，并在传输前后校验 SHA-256；只有 archive 不可用且发布负责人明确批准时，才能使用上一段的精确 tag/commit 本地构建例外。有 GHCR 凭证时按 digest 拉取，凭证只授予读取权限。无论哪种方式，服务器 `docker image inspect` 的版本、revision 和 image ID/digest 必须与该环境最终 manifest 一致。

Compose 的非敏感部署变量只包含版本、commit、artifact hash、端口和镜像前缀。数据库 URL、数据库口令、MFA/LLM/集成/通知密钥、Resend 与 Udun 凭证分别存放在 `/etc/agentnovas-riverton/*.env`，通过 Compose secret 只读挂载；不得用 `docker inspect` 可见的普通 `environment` 传递密钥。使用本机 Docker Compose 的 bind-backed secret 时，secret 根目录保持 `0700 root:root`，Node 容器读取的七个 `*.env` 文件使用 `0440 root:<容器 node 的 gid>`；原始数据库口令、角色口令和独立 Key 文件继续使用 `0600 root:root`。不得为了可读性把 secret 根目录或文件改为 world-readable。

配置预检必须先执行：

```bash
RIVERTON_RELEASE_VERSION=1.0.0-beta.1 \
RIVERTON_COMMIT_SHA=<40位commit> \
RIVERTON_ARTIFACT_SHA256=<64位manifest摘要> \
docker compose -f deploy/container/compose.yml config --quiet
```

## 2. 部署

1. 在切换制品前先停止任何已运行的 legacy Research Worker，移除旧 enable symlink 并确认进程消失。新 unit 文件不会自动停止已运行的旧进程。
2. 迁移只在显式 staging/生产变更授权后执行；本实施阶段不得运行生产 migration。
   迁移 registry 中任何已应用文件缺 checksum 或 checksum 不匹配都会失败关闭；不得直接补写 hash。先核对最后部署版本，必要时用新的 forward migration 修复。
3. 部署新 release 目录并验证 hash，不覆盖 previous。
4. 在维护窗口应用尚未部署的前向迁移；其中 `0029_beta_legacy_runtime_hard_close.sql` 终结非 `spot_usdt` 部署，`0036_pre_disclosure_trial_remediation.sql` 冻结披露前错误启动的历史试用并保留审计，`0037_bootstrap_system_role_permission_sync.sql` 同步既有 bootstrap 系统角色权限，`0038_client_ai_runtime_credits.sql` 建立 Client 模型安全投影和 AI 调用幂等账本，`0039_maintenance_idempotency.sql` 建立 Maintenance 高风险命令终态记录，`0040_client_identity_rls.sql` 隔离 Client 与内部身份数据，`0041_release_version_management.sql` 建立 Maintenance-only 不可变发布证据，`0042_udun_deposit_gateway.sql` 建立优盾 deposit-only 地址、回调证据、幂等和安全投影边界，`0043_client_identity_gateway_hardening.sql` 撤销 Client 对身份/邀请表的直接能力并收敛强制 RLS 与 gateway ACL。所有文件必须由迁移器按 checksum 顺序应用，禁止手工摘抄执行；`0043` 后必须重新执行最小角色模板，收敛业务表 ACL、Client Web/Auth/payment webhook capability 和发布表的 Maintenance-only `SELECT/INSERT` grants。
5. 原子切换 current；按 Client→Operations→Maintenance→Notification/Demo→官方 spot Runtime 顺序 readiness。Beta 不重启 Research Worker，即使环境误设为 true 也必须保持硬关闭。
6. 运行三 Host 登录/404/Cookie、安全 header 与关键只读 smoke；Maintenance 对 Research 的有效状态必须为 `disabled`。
7. 外部副作用开关保持默认 off；Email/Demo 分别经过独立 go-live 记录。
8. 每个环境完成实际部署和 smoke 后，再由有 `maint.releases.approve` 的人员登记 succeeded/failed 证据。production succeeded 必须已有同版本 staging succeeded；登记成功不是执行成功的替代品。

### 2.1 容器化分阶段发布

1. 为版本建立只读 release 目录，保存 compose、release manifest 和非敏感部署元数据；`current`/`previous` 只指向完整版本目录，不能指向工作区。
2. 首次仅执行 `docker compose up -d postgres`。Fresh 库按 1.1 先 bootstrap migrator；`migrator.env` 必须显式设置 `POSTGRES_MIGRATION_SCHEMA=public`，由 migrator 容器执行全部 checksum migration，再执行 `least-privilege-roles.sql`、设置独立运行角色口令并运行 role policy。迁移器保持角色默认 `search_path=pg_catalog,public`，只在单个迁移事务内临时使用经校验的 `public,pg_catalog`，且 registry 始终使用 schema-qualified 表名。生产迁移必须有本次发布的显式变更授权。
3. 使用 `docker compose up -d client operations maintenance` 并行启动三端，端口只绑定回环地址。依次用正确 Host 请求 `/api/health/live`、`/api/health/ready` 和 `/login`；错误 Host/audience 必须 404。
4. 未完成 Resend allowlist/Webhook 或平台 Demo 凭证 smoke 时，不启用 `workers` profile。启用时逐个启动 Notification、Demo、Runtime，分别等待真实 heartbeat；进程 `running` 不能替代 `healthy`。
5. 将反向代理接入 `agentnovas-riverton-edge` 网络，只先增加 `zht`/`xm` 或受控 staging 路由。确认 Cloudflare 到 origin TLS、Host、CSP、Cookie 和登录限流后，再切换根域 Client。不得停止或删除原服务作为“切流”。
6. 保存切流前后的代理配置摘要、三端 HTTP 证据、容器 image ID、数据库 migration registry、角色校验和 Worker 状态。完成后才更新 `current`，原目标写入 `previous`。

禁止执行 `docker compose down --volumes`、删除 `agentnovas-riverton-postgres`、复用其他项目数据库或让 Web 使用 postgres/migrator 账号。

`0038` 上线前必须确认 `LLM_PROFILE_ENCRYPTION_KEY` 与既有 Profile 密文匹配；不匹配时先在隔离环境执行受控 rekey，禁止用新 Key 直接覆盖。AI 或 Maintenance 幂等记录超过处理时限时只允许进入人工核对终态，不能用同一键再次触发 provider 或外部源；核对 requestId/traceId、provider request ID 与安全审计后使用新键发起明确的新操作。

## 3. 首小时监控

监控 5xx/p95、401/403/cross-audience reject、DB pool、Worker heartbeat/queue、Client JS error、邀请/商业披露/订单/credits/paper/Demo/Email/statement 转化与异常。任何 fake state、重复副作用或安全越界立即停止新邀请。

## 4. 应用回滚

1. 停止新增副作用与相关 Worker claim；保留事件/队列。
2. 原子切回 previous，逐端 readiness/Host smoke。
3. 不回滚已执行的向前兼容 migration；旧应用必须与 expand schema 兼容。
4. 对已提交商业事件使用幂等重放/reversal/补偿，不修改/删除历史。
5. 目标 5 分钟内恢复应用；记录时间线、commit、requestIds、影响和后续措施。
6. 目标版本曾在同环境成功部署且回滚 smoke 完成后，在 `/releases` 登记 rollback succeeded；失败尝试登记 failed，不改写既有记录。
7. 容器回滚使用 previous manifest 中的精确镜像 ID/digest和 compose 文件；只重新创建应用/Worker 容器，不删除 PostgreSQL volume。回滚后再次验证三 Host、数据库角色与 release runtime 元数据。

## 5. 数据恢复

只在 incident commander、数据库负责人和业务负责人共同批准后恢复。先按 1.2 在隔离实例验证备份时间、checksum、迁移版本和逐表行数；确定 RPO/RTO 与影响客户。恢复不能代替账本 reversal，也不能覆盖更晚的合法商业事件。生产恢复必须另行授权，不能直接复用只允许本机受控库名的演练脚本。
