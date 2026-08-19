# 自有 Linux 上线运行手册

## 边界

生产架构固定为自有 Linux 服务器上的三个 Node Web 应用、PostgreSQL、独立 Research Worker、独立 Runtime Worker、独立 Payment Worker、独立 Notification Worker 和 Nginx。所有服务共享 PostgreSQL，但必须分别启停；数据库迁移是显式部署步骤，不放进并发的服务启动钩子。不部署 Redis，也不使用边缘 Runtime 或代理平台。

## 1. 服务器准备

- 安装 Linux、Node.js 22.21+、PostgreSQL 16+、Nginx 和 Certbot。
- 创建无登录用户 `agentnovas`，将只读应用制品部署到 `/opt/agentnovas/current`。
- 将环境文件放在 `/etc/agentnovas/agentnovas.env`，所有者为 `root:agentnovas`，权限为 `0640` 或更严格。
- 为应用创建最小权限 PostgreSQL 用户；模型和交易所密钥的加密主密钥不得提交到 Git。
- Cloudflare 只作为 DNS 注册商/权威 DNS 使用，三个站点记录必须为 DNS-only，直接指向 Linux/Nginx。

## 2. 数据备份与迁移

在每次发布前执行 PostgreSQL 逻辑备份并记录 SHA-256：

```bash
install -d -m 0700 /var/backups/agentnovas
pg_dump --format=custom --file=/var/backups/agentnovas/predeploy.dump "$DATABASE_URL"
sha256sum /var/backups/agentnovas/predeploy.dump
```

先在隔离数据库恢复备份并验证关键表行数、登录、租户隔离和研究队列，再在维护窗口执行：

```bash
npm ci
npm run build
DATABASE_URL='postgresql://…' npm run postgres:migrate
```

`postgres/migrations/*.sql` 按文件名顺序执行并可重复运行。迁移失败时禁止启动新版本，恢复上一应用制品；涉及不可逆数据变更时，从已验证备份恢复到新的数据库实例后再切换连接串。

## 3. 启动顺序

1. 停止 Research Worker 与 Runtime Worker，等待已租任务完成或租约安全过期。
2. 开启维护页并停止 Web 写入。
3. 备份 PostgreSQL，执行迁移和核验。
4. 启动 Web，检查 `/api/health`、登录、租户隔离、账户读取、策略详情与版本回滚。
5. 启动 `riverton-client`、`riverton-operations` 和 `riverton-maintenance`，分别检查客户端、运营端和运维端登录 Cookie 隔离。
6. 确认七个研发 Agent 角色均已绑定并通过连通测试；按需单独绑定市场摘要、反方异议和风控结论三个运行时解释模型。运行时解释未配置不阻止确定性周期。
7. 设置 `STRATEGY_RESEARCH_ENABLED=true`，启动研究 Worker。
8. 验证任务创建、SSE 断线续传、候选保存、回测结果和取消恢复。
9. 设置 `STRATEGY_RUNTIME_ENABLED=true` 启动 Runtime Worker，完成至少一个影子周期和一个模拟开平仓闭环。若启用运行时解释，另外验证模型超时后周期仍为 `completed`，解释任务进入有限重试且订单意图不变。
10. 支付和通知 Worker 默认保持关闭；只有服务商、Resend、Webhook 签名和对账演练完成后，才设置 `PAYMENT_WORKER_ENABLED=true` 与 `NOTIFICATION_WORKER_ENABLED=true`。
11. Nginx 直接切换三个域名流量并持续观察错误率、队列租约和数据库连接。

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

1. 停止 Research、Runtime、Payment 和 Notification Worker，开启维护页。
2. 回切上一应用制品。
3. 如果 schema 向后兼容，直接启动旧 Web；否则把已验证备份恢复到新实例并回切 `DATABASE_URL`。
4. 保留失败版本日志、迁移记录和研究任务事件，禁止把密钥或个人信息写入事故报告。

## 6. 发布证据

- PostgreSQL 备份 SHA-256、恢复演练和关键表核验结果。
- 定向测试、全量测试、生产构建、ESLint、依赖审计和真实浏览器验收输出。
- systemd 状态、`nginx -t`、健康检查和功能开关变更记录；健康检查应包含解释角色数、待处理解释任务和近 24 小时解释失败数。
- 不保存模型 API Key、交易所密钥、数据库密码或 Agent 隐藏推理内容。
