# Riverton Capital 付费 Beta 发布与回滚 Runbook

## 1. 发布前

- 核对 commit、artifact hash、Node/PostgreSQL 版本、migration checksums 和所有 Gate 证据。
- 检查 `.env`、密钥、密码、私钥、数据库备份、日志、截图、trace 和 fixture 未进入 Git/artifact。
- 三端/Workers/migrator 使用独立最小 env/DB role；Payment Worker disabled。Demo Worker 的 `DEMO_EXECUTION_WORKER_ENABLED` 与 `PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED` 分离管理，进程存活不等于已授权向 provider 写入。
- 从 `deploy/env/*.env.example` 分别生成 `/etc/agentnovas/client.env`、`operations.env`、`maintenance.env`、`notification.env`、`demo.env`、`research.env`、`runtime.env`；权限不得高于 `0640`，禁止重新合并成共享密钥文件。
- 仓库不再提供旧 `agentnovas-web.service`、Payment Worker unit 或旧单端 Nginx 配置；只安装 `deploy/systemd/` 当前 units 与 `deploy/nginx/riverton-three-apps.conf`。
- `systemd-analyze verify`、`nginx -t`、端口/server name/Cookie/Host/TLS/CSP smoke 通过。
- 备份恢复、fresh/N-1 migration、current/previous 应用回滚演练完成。

## 2. 部署

1. 在切换制品前先停止任何已运行的 legacy Research Worker，移除旧 enable symlink 并确认进程消失。新 unit 文件不会自动停止已运行的旧进程。
2. 迁移只在显式 staging/生产变更授权后执行；本实施阶段不得运行生产 migration。
   迁移 registry 中任何已应用文件缺 checksum 或 checksum 不匹配都会失败关闭；不得直接补写 hash。先核对最后部署版本，必要时用新的 forward migration 修复。
3. 部署新 release 目录并验证 hash，不覆盖 previous。
4. 在维护窗口应用 `0029_beta_legacy_runtime_hard_close.sql`：它终结非 `spot_usdt` 部署、取消非终态 legacy research 任务、清理租约并写审计；重放幂等。
5. 原子切换 current；按 Client→Operations→Maintenance→Notification/Demo→官方 spot Runtime 顺序 readiness。Beta 不重启 Research Worker，即使环境误设为 true 也必须保持硬关闭。
6. 运行三 Host 登录/404/Cookie、安全 header 与关键只读 smoke；Maintenance 对 Research 的有效状态必须为 `disabled`。
7. 外部副作用开关保持默认 off；Email/Demo 分别经过独立 go-live 记录。

## 3. 首小时监控

监控 5xx/p95、401/403/cross-audience reject、DB pool、Worker heartbeat/queue、Client JS error、邀请/法务/订单/credits/paper/Demo/Email/statement 转化与异常。任何 fake state、重复副作用或安全越界立即停止新邀请。

## 4. 应用回滚

1. 停止新增副作用与相关 Worker claim；保留事件/队列。
2. 原子切回 previous，逐端 readiness/Host smoke。
3. 不回滚已执行的向前兼容 migration；旧应用必须与 expand schema 兼容。
4. 对已提交商业事件使用幂等重放/reversal/补偿，不修改/删除历史。
5. 目标 5 分钟内恢复应用；记录时间线、commit、requestIds、影响和后续措施。

## 5. 数据恢复

只在 incident commander、数据库负责人和业务负责人共同批准后恢复。先在隔离实例验证备份时间、checksum、迁移版本和关键行数；确定 RPO/RTO 与影响客户。恢复不能代替账本 reversal，也不能覆盖更晚的合法商业事件。
