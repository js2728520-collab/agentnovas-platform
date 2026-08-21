# 自有 Linux 上线运行手册

## 边界

生产架构固定为自有 Linux 服务器上的三个 Node Web 应用、PostgreSQL、官方 spot-only Runtime Worker、独立 Notification Worker、受控 Demo Execution Worker 和 Nginx。受邀付费 Beta 硬关闭 legacy Research Worker，不安装 Payment Worker unit。所有服务共享 PostgreSQL，但必须分别启停；数据库迁移是显式部署步骤，不放进并发的服务启动钩子。不部署 Redis，也不使用边缘 Runtime 或代理平台。

## 1. 服务器准备

- 安装 Linux、Node.js 22.21+、PostgreSQL 16+、Nginx 和 Certbot。
- 创建无登录用户 `agentnovas`，将只读应用制品部署到 `/opt/agentnovas/current`。
- 从 `deploy/env/*.env.example` 分别建立 `/etc/agentnovas/client.env`、`operations.env`、`maintenance.env`、`notification.env`、`demo.env`、`runtime.env`、`migrator.env`；所有者为 `root:agentnovas`，权限为 `0640` 或更严格。Beta 不建立或加载 legacy `research.env`，不得合并成共享密钥文件。
- 为每个进程创建最小权限 PostgreSQL 用户。Client 的业务连接必须使用 `agentnovas_client_web`，登录投影连接必须使用独立 `agentnovas_client_auth`；两者都不能直读身份/邀请表。模型和交易所密钥的加密主密钥不得提交到 Git。
- Cloudflare 只作为 DNS 注册商/权威 DNS 使用，三个站点记录必须为 DNS-only，直接指向 Linux/Nginx。

## 2. 数据备份与迁移

在每次发布前执行 PostgreSQL 逻辑备份并记录 SHA-256：

```bash
install -d -m 0700 /var/backups/agentnovas
pg_dump --format=custom --file=/var/backups/agentnovas/predeploy.dump "$DATABASE_URL"
sha256sum /var/backups/agentnovas/predeploy.dump
```

先在隔离数据库恢复备份并验证关键表行数、登录、租户隔离和官方 Paper 队列。Fresh 环境由管理员先执行 `deploy/postgres/bootstrap-migrator.sql`，随后只使用 migrator 连接执行迁移，再由管理员以单事务执行 `deploy/postgres/least-privilege-roles.sql`，最后运行 `scripts/release/postgres-role-policy.mjs`：

```bash
npm ci
npm run build
DATABASE_URL='postgresql://agentnovas_migrator@127.0.0.1/agentnovas' npm run postgres:migrate
RELEASE_ROLE_POLICY_DATABASE_URL='postgresql://agentnovas_migrator@127.0.0.1/agentnovas' \
  node scripts/release/postgres-role-policy.mjs
```

`postgres/migrations/*.sql` 按文件名顺序执行，registry checksum 不变时可安全重跑。迁移失败或角色策略出现 finding 时禁止启动新版本，恢复上一应用制品；涉及不可逆数据变更时，从已验证备份恢复到新的数据库实例后再切换连接串。

## 3. 启动顺序

1. 停止任何已运行的 legacy Research Worker 与 Runtime Worker，移除旧 Research enable symlink，并等待已租任务终止或租约安全过期。新 unit 不会自动停止旧进程。
2. 开启维护页并停止 Web 写入。
3. 备份 PostgreSQL，执行迁移和核验。
4. 启动 Web，检查 `/api/health`、登录、租户隔离、账户读取、策略详情与版本回滚。
5. 启动 `riverton-client`、`riverton-operations` 和 `riverton-maintenance`，分别检查客户端、运营端和运维端登录 Cookie 隔离。
6. 确认七个研发 Agent 角色均已绑定并通过连通测试；按需单独绑定市场摘要、反方异议和风控结论三个运行时解释模型。运行时解释未配置不阻止确定性周期。
7. 保持 `STRATEGY_RESEARCH_ENABLED=false`。Beta 不启动 Research Worker；即使环境误设为 true，启动脚本、租约和 orchestrator 也必须在读取数据库/客户凭证前失败关闭。
8. 执行 `0029_beta_legacy_runtime_hard_close.sql`，核对所有存量非 `spot_usdt` deployment 已终结、非终态 research run 已取消、租约已清理且审计事件存在。
9. 设置 `STRATEGY_RUNTIME_ENABLED=true` 启动官方 spot-only Runtime Worker，验证租约和处理器仅接受完整官方绑定、`exchange_account_id IS NULL` 的 `spot_usdt` deployment，完成至少一个影子周期和一个 paper 开平仓闭环。
10. Beta 不安装或启用 Payment Worker。Notification Worker 可在外发关闭时运行密文清理与 heartbeat；真实邮件仍必须同时满足 `NOTIFICATION_WORKER_ENABLED=true`、`NOTIFICATION_EMAIL_SEND_ENABLED=true`、Resend/域名/Webhook/suppression/allowlist 完整配置和显式授权。
11. Demo Execution Worker 默认不启动。`DEMO_EXECUTION_WORKER_ENABLED` 只表示进程应运行并上报 heartbeat；`PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED` 是独立的外部写授权。可先只开前者验证存活与队列诊断；只有 staging 平台测试凭证、provider/card kill switch、告警和值班就绪并获得专项授权后，才可把后者设为 `true`。运维端必须分别显示进程启用、外部写授权和 heartbeat 状态。
12. Nginx 直接切换三个域名流量并持续观察错误率、队列租约和数据库连接。

### 3.1 Resend 上线验收

1. 在 Resend 创建 HTTPS Webhook，地址指向 `https://xm.agentnovas.com/api/integrations/resend/webhook`，订阅 `email.sent`、`email.delivery_delayed`、`email.delivered`、`email.opened`、`email.clicked`、`email.complained`、`email.bounced`、`email.failed` 和 `email.suppressed`。
2. 将 `RESEND_WEBHOOK_SECRET` 仅写入 `maintenance.env`，将 `RESEND_API_KEY` 仅写入 `notification.env`；两者均由 root 持有、服务组只读。Web 端最多返回“是否存在”的布尔状态，不得返回密钥值。不得把任一密钥写入仓库、命令历史或运维截图。
3. 执行 `npm run postgres:migrate`，确认 `0018_resend_delivery_events.sql` 已应用；检查 `notification_deliveries.provider_event_at` 和 `resend_webhook_events.mapped_delivery_id` 存在。
4. 在运维端把 Resend 邮件服务商状态设为 `active`，确认 `agentnovas.com` 发件域已验证。保持两个通知开关为 `false`，先使用服务商测试事件验证签名错误返回 401、合法事件在事务提交后返回 200。
5. 开启 Notification Worker 后发送一个受控测试邮件，确认投递记录依次达到 `sent` 或 `delivered`，相同 `svix-id` 重放不重复应用，旧事件不会覆盖新状态。Webhook 返回非 200 时 Resend 会重试，因此必须先排除数据库迁移、连接和字段映射错误。
6. 验收完成后才同时启用 `NOTIFICATION_WORKER_ENABLED=true` 与 `NOTIFICATION_EMAIL_SEND_ENABLED=true`。若持续出现 5xx、签名失败、事件无法映射或队列租约异常，立即关闭两个开关并保留事件/投递审计记录。

## 4. systemd 与 Nginx

复制 `deploy/systemd/*.service` 到 `/etc/systemd/system/`，复制 Nginx 示例并先执行 `nginx -t`。Web 和 Worker 使用同一个只读部署目录；运行时只允许写入 `/var/lib/agentnovas`。

证书直接使用 Certbot 申请和续期：

```bash
certbot certonly --nginx -d agentnovas.com -d www.agentnovas.com -d zht.agentnovas.com -d xm.agentnovas.com
nginx -t && systemctl reload nginx
systemctl enable --now certbot.timer
```

SSE 路由必须设置 `proxy_buffering off`，并将读取超时提高到一小时。验收断线后通过事件序号恢复，同时确认轮询回退可用。

## 5. 回滚条件

出现关键表校验不一致、跨租户可见、登录失败、Worker 无法续租、行情数据质量异常或持续 5xx 时：

1. 停止 Research、Runtime、Demo Execution 和 Notification Worker，开启维护页。
2. 回切上一应用制品。
3. 如果 schema 向后兼容，直接启动旧 Web；否则把已验证备份恢复到新实例并回切 `DATABASE_URL`。
4. 保留失败版本日志、迁移记录和研究任务事件，禁止把密钥或个人信息写入事故报告。

## 6. 发布证据

- PostgreSQL 备份 SHA-256、恢复演练和关键表核验结果。
- 定向测试、全量测试、生产构建、ESLint、依赖审计和真实浏览器验收输出。
- systemd 状态、`nginx -t`、健康检查和功能开关变更记录；健康检查应包含解释角色数、待处理解释任务和近 24 小时解释失败数。
- 不保存模型 API Key、交易所密钥、数据库密码或 Agent 隐藏推理内容。
