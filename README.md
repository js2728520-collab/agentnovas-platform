# Riverton Capital

Riverton Capital 是面向数字资产策略研究、真实历史回测、模拟盘验证、会员和充值账务的平台。本仓库的运行底座是原生 Next.js/Node.js、PostgreSQL、独立 Worker 和 Nginx，目标部署环境为自有 Linux 服务器。

## 技术边界

- Web：Next.js 16 / React 19，运行于 Node.js。客户端、运营端和运维端使用独立 audience、端口和 Cookie。
- 数据库：PostgreSQL；Web 与 Worker 使用同一个 `DATABASE_URL`。
- 后台任务：研究、运行时、支付和通知使用独立 Node Worker，通过 PostgreSQL 持久化状态，不依赖 Redis。
- 反向代理：生产环境使用 Nginx，SSE 路由关闭代理缓冲。
- 交易：本期只开放策略生成、历史回测和模拟盘闭环，真实永续订单路由保持关闭。
- Cloudflare 仅可作为 DNS 注册商/权威 DNS；不使用 Proxy、Workers、Pages、D1 或 Tunnel。

## 本地启动

要求 Node.js 22.21+ 和 PostgreSQL 16+。Node 版本要求包含环境代理支持，供交易所合约与行情请求使用。

```bash
npm ci
npm run postgres:migrate
npm run dev:client
```

三个应用本地入口：

```bash
npm run dev:client       # http://127.0.0.1:3000
npm run dev:operations   # http://127.0.0.1:3001
npm run dev:maintenance  # http://127.0.0.1:3002
```

在另一个终端按需启动 Worker：

```bash
npm run worker:research
npm run worker:runtime
npm run worker:payment
npm run worker:notification
```

本地环境变量放在 `.env.local`，至少配置：

```dotenv
DATABASE_URL=postgresql://agentnovas:password@127.0.0.1:5432/agentnovas
BOOTSTRAP_SECRET=replace-me
EXCHANGE_CREDENTIAL_ENCRYPTION_KEY=replace-with-32-byte-key
LLM_PROFILE_ENCRYPTION_KEY=replace-with-32-byte-key
STRATEGY_RESEARCH_ENABLED=true
STRATEGY_RUNTIME_ENABLED=true
PAYMENT_WORKER_ENABLED=false
NOTIFICATION_WORKER_ENABLED=false
STRATEGY_RUNTIME_EXPLANATION_TIMEOUT_MS=30000
PLATFORM_EMERGENCY_STOP=false
```

模型 API Key 和交易所密钥只在服务端加密保存，禁止提交到 Git、写入浏览器或输出到日志。

## 常用命令

- `npm run dev:client`：启动客户端，端口 3000。
- `npm run dev:operations`：启动运营端，端口 3001。
- `npm run dev:maintenance`：启动运维端，端口 3002。
- `npm run worker:research`：启动独立策略研究 Worker。
- `npm run worker:runtime`：启动影子盘/模拟盘 Runtime Worker；不会发送真实订单。
- `npm run worker:payment`：启动支付 Worker；默认要求 `PAYMENT_WORKER_ENABLED=true`。
- `npm run worker:notification`：启动通知 Worker；默认要求 `NOTIFICATION_WORKER_ENABLED=true`。
- `npm run postgres:migrate`：应用 PostgreSQL 迁移。
- `npm run build`：生成生产构建并执行 TypeScript 检查。
- `npm run start`：启动生产构建。
- `npm run lint`：执行 ESLint。
- `npm test`：生产构建和页面渲染验收。

## Linux 部署

生产环境使用 `/etc/agentnovas/agentnovas.env` 保存 `0600` 权限的环境变量，通过 systemd 分别管理三个 Web 服务、Research Worker、Runtime Worker、Payment Worker 和 Notification Worker，再由 Nginx 直接为 `agentnovas.com`、`zht.agentnovas.com` 和 `xm.agentnovas.com` 提供 TLS 与反向代理。

部署模板位于：

- `deploy/systemd/riverton-client.service`
- `deploy/systemd/riverton-operations.service`
- `deploy/systemd/riverton-maintenance.service`
- `deploy/systemd/riverton-payment-worker.service`
- `deploy/systemd/riverton-notification-worker.service`
- `deploy/systemd/agentnovas-research-worker.service`
- `deploy/systemd/agentnovas-runtime-worker.service`
- `deploy/nginx/riverton-three-apps.conf`
- `docs/runbooks/self-hosted-strategy-research.md`

发布前先迁移数据库，再启动 Web；健康检查、登录和租户隔离通过后，最后开启研究功能并启动 Worker。

## 策略研发原则

LLM 只负责需求结构化、市场状态解释、独立提案、反方审查、风险说明和报告。交易运行时的市场、反方与风控说明是独立异步任务；确定性周期会先提交，解释超时不会阻塞或改写信号、风控和模拟订单。DSL 白名单校验、参数搜索、回测、评分和准入全部由确定性代码执行。回测结果是历史证据，不构成未来收益承诺；没有候选达到门槛时，系统必须明确显示未通过。
