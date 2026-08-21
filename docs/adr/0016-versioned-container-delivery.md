# ADR-0016：按版本交付三端不可变容器镜像

状态：Accepted
日期：2026-08-21

## 背景

现有 systemd/Nginx 模板可以运行三个 Node 进程，但没有把 Git tag、三端编译产物、Worker 运行时和服务器切换绑定成可重复验证的制品。目标主机已经运行其他服务，直接覆盖目录或复用 `latest` 会破坏回滚证据，也可能误伤既有流量。

## 决策

1. Git tag 使用 `vMAJOR.MINOR.PATCH[-prerelease]`，容器 tag 使用去掉前导 `v` 的同一 SemVer；`latest` 永不生成、部署或作为回滚目标。
2. Client、Operations、Maintenance 分别以固定 audience 编译为三个 Next.js standalone 镜像。第四个 runtime 镜像承载 Notification、官方 spot Runtime、Demo Worker 和显式 migrator 命令；Payment 与 legacy Research 不进入发布 Compose。
3. 镜像写入完整 commit、SemVer 与 OCI source label。四张镜像 ID/digest、migration version、tag 和 commit 形成 release manifest；该 manifest 的 SHA-256 是 `RIVERTON_ARTIFACT_SHA256`。
4. PostgreSQL 16 使用 digest 固定的独立容器和持久卷，不发布 5432 主机端口。Web、Worker、migrator 继续使用不同数据库角色；migrator 只在 `tools` profile 下显式运行，Web/Worker 启动不得隐式执行 migration。
5. 敏感运行环境以宿主机受限文件挂载到 `/run/secrets/*.env`，由 Node `--env-file` 读取。数据库口令、Resend/Udun 凭证和加密密钥不写入镜像、Compose、Git、构建参数或 OCI label。
6. 三端容器以非 root、只读根文件系统、capability 全撤销和 `no-new-privileges` 运行；只为 `/tmp` 与 audience cache 挂载 tmpfs。公开端口仅绑定 `127.0.0.1:3100–3102`，由受控反向代理接入。
7. 首次发布先在同一主机并行启动，不覆盖现有根域服务。readiness、Host/audience、Cookie、数据库角色和安全 smoke 全部通过后，才逐域切换反向代理。每个旧路由保留明确 previous 目标，应用回滚不回退已经执行的前向兼容数据库迁移。
8. tag push 触发 GitHub Actions 的相同测试门禁和四镜像构建，发布到 GHCR 时同时保存版本 tag 与 commit tag、SBOM、provenance 和 digest 证据。本地/服务器首发仍须验证同一 commit；远端 Registry 失败不能降级为未标识制品。

## 后果

- 后续迭代按 SemVer 生成新镜像，部署记录可以从 tag 追溯到 commit、migration 和每张镜像。
- audience 代码在构建阶段隔离，Client 镜像不包含 Operations/Maintenance 应用入口，内部镜像也不会加载交易大厅应用树。
- 数据库与 secret 生命周期独立于应用镜像；删除容器不会删除业务卷，任何 `down --volumes` 都属于禁止的破坏性操作。
- 单主机当前只运行每端一个实例，不引入 Redis。未来扩为多实例前，必须先实现 Next cache/tag 协调和一致的 Server Action encryption key。
