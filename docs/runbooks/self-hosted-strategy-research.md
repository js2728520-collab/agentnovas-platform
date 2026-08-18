# 自有 Linux 上线与 D1 切换运行手册

## 边界

本手册覆盖 Node Web、PostgreSQL、独立研究 Worker、Nginx/SSE 和 D1 一次性迁移。代码已提供完整业务 PostgreSQL schema、D1 兼容查询层和 40 表迁移核验；真正的生产备份、目标服务器预演、整站冒烟和维护窗口切换仍必须按本手册执行，不能把本地验证视为已上线证明。

## 1. 服务器准备

- Linux、Node.js 22.13+、PostgreSQL 16+、Nginx、Certbot。
- 创建无登录用户 `agentnovas`，代码只读部署到 `/opt/agentnovas/current`。
- 环境文件放在 `/etc/agentnovas/agentnovas.env`，权限 `0600`；参考 `deploy/agentnovas.env.example`。
- `DATABASE_URL` 使用专用最小权限数据库用户；模型密钥加密主密钥不得提交到 Git。

## 2. 构建与全量 PostgreSQL schema 迁移

```bash
npm ci
npm run build
DATABASE_URL='postgresql://…' npm run postgres:migrate
```

迁移脚本按文件名顺序执行 `postgres/migrations/*.sql`。`0000_business_schema.sql` 建立与最终 D1 线协议兼容的 40 张业务表，后续文件建立研究队列与模型编排表；全部迁移可重复运行。

## 3. D1 全量备份与预演

在 Cloudflare 凭据已配置的受控主机导出只读备份：

```bash
npx wrangler d1 export AGENTNOVAS_DB --remote --output /var/backups/agentnovas/d1-precutover.sqlite
sha256sum /var/backups/agentnovas/d1-precutover.sqlite
```

先在隔离 PostgreSQL 数据库执行 `npm run postgres:migrate`，再确认 40 张目标业务表全部为空：

```bash
DATABASE_URL='postgresql://…/agentnovas_staging' \
D1_SQLITE_PATH='/var/backups/agentnovas/d1-precutover.sqlite' \
D1_MIGRATION_BATCH_ID='preflight-20260818-01' \
D1_SOURCE_REF='cloudflare-d1-export:sha256:…' \
npm run postgres:migrate:d1
```

命令在一个事务内导入，外键延迟到提交时检查，并逐表核对行数和规范化 SHA-256；任一目标表非空、表缺失、外键异常或哈希失败都会回滚所有业务行并写入失败批次。相同已验证批次重复执行为只读 no-op。

## 4. 维护窗口切换

1. 将旧站切到维护页，停止所有写入和定时任务。
2. 导出最终 D1 备份并记录 SHA-256、对象存储版本和操作人。
3. 对空的生产 PostgreSQL 业务 schema 执行一次性导入与核验；禁止长期双写。
4. 运行登录、租户隔离、账户读取、策略详情、版本回滚和研究 API 冒烟测试。
5. 使用带 `DATABASE_URL` 的生产构建启动 Web，确认健康检查为 ready、登录和核心业务冒烟全部通过；Worker 仍保持关闭。
6. 管理员建立并测试七个模型角色；确认密钥未进入日志后，把 `STRATEGY_RESEARCH_ENABLED` 改为 `true`，再启动 Worker。
7. 观察错误率、队列租约、数据库连接、SSE 重连和外部模型成本，确认稳定后切换 `agentnovas.com`。

回滚条件包括关键表哈希不一致、跨租户可见、登录失败、Worker 无法续租或行情质量错误。回滚时停止新服务，恢复维护页，将域名流量指回旧版本；不要反向覆盖最终 D1 备份。

## 5. systemd 与 Nginx

复制 `deploy/systemd/*.service` 到 `/etc/systemd/system/`，复制 Nginx 示例并先运行 `nginx -t`。Web 和 Worker 必须分别启停；数据库迁移作为部署步骤显式执行，不放在两个服务的并发 `ExecStartPre` 中。

SSE 路由必须关闭代理缓冲并把读取超时提高到一小时。上线前验证断线时携带最后序号恢复，且轮询回退仍可用。

## 6. 验收与证据

- 保存 D1 文件 SHA-256、逐表核验 JSON、迁移批次状态和备份位置。
- 保存定向测试、全量测试、构建、ESLint、依赖审计和浏览器验收输出。
- 保存 systemd 状态、Nginx 配置测试、PostgreSQL 备份恢复演练和功能开关变更审计。
- 不保存模型 API Key、交易所密钥、数据库密码或隐藏推理内容。
