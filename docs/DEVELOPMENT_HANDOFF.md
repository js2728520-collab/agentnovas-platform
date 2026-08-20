# AgentNovas 开发环境交接说明

## 1. 接管入口

本文档是新开发环境和新 Codex 任务的第一入口。聊天记录不会自动随代码迁移，因此接管时必须依次阅读：

1. `AGENTS.md`
2. 本文档
3. `README.md`
4. `docs/adr/0003-postgresql-multi-agent-research-pipeline.md`
5. `docs/adr/0004-unified-dsl-v3-shadow-paper-runtime.md`
6. `docs/runbooks/self-hosted-strategy-research.md`
7. `git log -1 --stat` 与 `git status --short --branch`

当前开发分支已从 `codex/multi-agent-strategy-research` 切到 `codex/three-app-riverton-split`。交接版本以本文件所在的最新本地提交为准，不依赖未提交文件。

未经用户明确授权，禁止推送远程、创建 PR 或把仓库发布到任何托管平台。代码交接优先使用本地 Git bundle。

## 2. 不可改变的架构边界

- 目标部署为自有 Linux、Node.js 22.21+、PostgreSQL 16+、独立 Research Worker、独立 Runtime Worker、Nginx 和 Certbot。
- 不使用 Cloudflare Runtime，不引入 Redis。Web 与两个 Worker 以 PostgreSQL 为唯一持久化真源。
- 本期只提供策略研发、真实历史回测、影子盘和模拟盘；真实永续订单路由必须保持关闭。
- LLM 负责需求结构化、市场解释、独立提案、反方审查、风险说明和报告。DSL 校验、行情标准化、参数搜索、回测、评分、准入、风控和模拟订单意图由确定性代码控制。
- 回测是历史证据，不承诺未来收益。未达到门槛的候选必须明确标记 `NOT_QUALIFIED` 或“未通过标准验证”。
- 模型与交易所密钥只在服务端加密保存，不进入浏览器、Agent 公开事件、日志或 Git。

## 3. 本次本地提交交付内容

本次改造聚焦“我的策略”和“创建策略”工作区：

- “我的策略”改为可操作的策略列表与独立“回测与模拟”页签，移除无法点击、语义不清的标题卡片。
- 策略卡片增加创建时间、验证状态、回测状态，并提供“查看策略”“快速回测”“分享到策略广场”。
- 自用策略只有在用户明确点击分享时才切换为策略广场投稿；仍必须通过 `STANDARD_VERIFIED`，随后进入平台双人审核。
- 快速回测进入独立可视化工作区，显示真实服务端阶段进度、状态说明、核心指标、资金曲线和报告入口。
- 回测 API 保留原 JSON 响应，并新增 `?stream=1` 的 NDJSON 进度流。页面离开只断开进度订阅，不取消已经开始的服务端计算和报告保存。
- 创建策略页面扩展为更完整的工作区；成熟因子模板默认折叠，减少首屏拥挤。
- USDT 永续合约加载增加错误反馈和重试。Node Web/Worker 启用环境代理支持，解决受代理网络中 Binance 合约列表无法读取的问题。
- Node.js 最低版本统一提升到 22.21.0，以使用稳定的环境代理能力。

主要变更位置：

- `app/community-strategy-center.tsx`
- `app/strategy-backtest-center.tsx`
- `app/api/strategy-marketplace/[id]/backtest/route.ts`
- `app/api/strategy-marketplace/[id]/submit/route.ts`
- `app/multi-agent-research.tsx`
- `app/page.tsx`
- `app/globals.css`
- `next.config.ts`
- `package.json`

## 4. 已完成验证

本次提交前已完成：

- `node --test tests/*.test.mjs`：200 项全部通过。
- `npm run build`：通过。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 个错误；存在 7 个与本次改动无关的既有 warning，主要是图片元素和既有 effect 依赖提示。
- 真实浏览器验收：Binance USDT 永续合约接口成功返回并可选择 `BTCUSDT`。
- 真实浏览器验收：快速回测读取 1,000 根 K 线，阶段进度到达 100%，报告和资金曲线成功展示。

浏览器验收在本地开发数据库中新增了一条回测报告，属于测试数据。若迁移整个本地数据库，需要在新环境识别为验收记录，不应视为生产业绩。

## 5. 新环境启动

### 5.1 代码与依赖

```bash
node --version
npm ci
npm run postgres:migrate
npm run build
npm run dev
```

Web、Research Worker 和 Runtime Worker 分别启动：

```bash
npm run dev
npm run worker:research
npm run worker:runtime
```

Worker 不是 Web 进程的子任务。仅启动 Web 可以浏览页面，但后台研究和影子/模拟周期不会被消费。

### 5.2 配置与密钥

`.env`、`.env.local`、API Key、数据库口令、交易所凭证和加密主密钥不得放进 Git bundle。应通过密码管理器、加密磁盘或新环境的 Secret Manager 单独传输或重新创建。

如果数据库一并迁移，必须安全保留原有 `LLM_PROFILE_ENCRYPTION_KEY` 与 `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`，否则数据库中已加密的模型 Profile 和交易所凭证无法解密。不要把这两个值写入交接文档。

需要通过网络代理访问交易所时，在新环境安全配置 `HTTP_PROXY`、`HTTPS_PROXY` 和必要的 `NO_PROXY`；项目脚本已设置 `NODE_USE_ENV_PROXY=1`。不得把带认证信息的代理地址提交到 Git。

### 5.3 数据库

代码迁移不包含 PostgreSQL 数据。需要保留账号、模型绑定、策略、回测报告和可恢复研究任务时，应单独执行加密备份：

```bash
pg_dump --format=custom --no-owner --no-privileges \
  --file=agentnovas-development.dump "$DATABASE_URL"
sha256sum agentnovas-development.dump
```

在新环境创建空数据库后恢复，再执行幂等迁移：

```bash
pg_restore --no-owner --no-privileges \
  --dbname="$DATABASE_URL" agentnovas-development.dump
npm run postgres:migrate
```

数据库备份包含用户和业务数据，应加密传输、限制访问，并且不得加入仓库。

## 6. 无远程推送的代码移交方式

在旧环境完成本地提交后创建单分支 Git bundle：

```bash
git status --short --branch
git bundle create ../agentnovas-codex-handoff.bundle \
  codex/three-app-riverton-split
git bundle verify ../agentnovas-codex-handoff.bundle
```

通过加密磁盘或可信文件传输把 bundle 复制到新环境，然后：

```bash
git clone agentnovas-codex-handoff.bundle agentnovas-platform
cd agentnovas-platform
git switch codex/three-app-riverton-split
git log -1 --stat
git status --short --branch
```

Git bundle 包含该分支的已提交代码和历史，不包含 `.env`、PostgreSQL、未跟踪上传文件或正在运行的进程。它不需要访问 GitHub，也不会暴露个人 GitHub 身份。

如果将来用户明确授权使用私有远程，再单独配置 Codex 提交身份和远程权限；授权前不得执行 `git push` 或创建 PR。

## 7. 新 Codex 接替提示词

在新环境用 Codex 打开仓库根目录后，可直接发送：

> 请先完整阅读 `AGENTS.md`、`docs/DEVELOPMENT_HANDOFF.md`、相关 ADR 和 `git log -1 --stat`，然后检查 `git status --short --branch`。继续在 `codex/three-app-riverton-split` 分支工作。不得推送远程或创建 PR，除非我明确授权。先报告当前架构、可运行状态和未完成事项，再开始修改。

Codex 仍然是同类开发代理，但新任务不会天然拥有旧聊天的短期记忆；仓库中的规则、交接文档、ADR、测试和 Git 历史才是可持续上下文。

## 8. 接管核验清单

- 分支为 `codex/three-app-riverton-split`，工作区干净，最新提交与旧环境一致。
- Node.js 不低于 22.21.0，`npm ci` 成功。
- PostgreSQL 恢复后的关键表行数和备份 SHA-256 记录一致，迁移完成。
- 登录、多租户隔离、模型角色绑定、交易所账户读取正常。
- `npm run build`、`node --test tests/*.test.mjs` 和 `npm run lint` 结果与交接基线一致。
- Web、Research Worker、Runtime Worker 分别启动，健康检查和租约正常。
- 合约选择、标准模式研究、SSE/轮询恢复、候选保存、动态回测、影子盘和模拟盘至少各完成一次验收。
- 客户响应和日志不显示供应商 Key、完整接口地址、数据库口令或隐藏推理。

## 9. 已知边界与后续工作

- 动态历史回测已经进入独立工作区；模拟盘仍由保存后的策略版本和 Runtime Worker 驱动，不会因为点击“快速回测”而自动部署。
- 真实永续订单路由仍关闭，任何后续开放都必须进行独立的高风险设计和安全评审。
- 生产 Linux 部署、真实域名切换和生产数据库迁移尚未在本次本地提交中执行。
- 交易所公开接口的可用性取决于新环境网络；代理配置不应被误判为 Cloudflare 依赖。
- 当前 lint 的 7 个既有 warning 可在后续独立清理，不能用全局忽略规则掩盖。

## 10. 2026-08-19 Riverton 三应用、RBAC、充值账本与邮件切片

本次后续增量以本地提交 `64ba128` 为基线，新建本地分支 `codex/three-app-riverton-split`，未推送远端。

已落地：

- 三应用 audience 合同：客户端 `agentnovas.com`、运营端 `zht.agentnovas.com`、运维端 `xm.agentnovas.com`。
- 三套独立本地脚本：`npm run dev:client`、`npm run dev:operations`、`npm run dev:maintenance`；生产启动脚本也按 audience 分开。
- 登录 session 增加 `app_audience`，三个应用使用独立 Cookie；客户端保留旧 `an_session` 兼容。
- 新增 RBAC 权限目录、固定数据范围、旧角色兼容映射、派生角色降权校验、敏感权限双审规则和有效权限 API。
- 新增 RBAC 管理 API：权限目录、有效权限、角色模板、角色、分配、变更申请、审批和审计查询；变更申请使用严格区分联合类型校验并绑定应用。
- 新增 PostgreSQL 迁移 `0015_riverton_three_app_rbac_wallet.sql`，覆盖 RBAC、充值订单、双式账本、钱包余额、风险、人工操作、对账、导出和通知服务商配置。
- 新增充值/钱包 API 骨架：余额、流水、充值订单创建和查询；未配置服务商时明确拒绝生成虚假充值地址。
- 新增运营端充值 API 骨架：列表、详情、统计、人工操作申请和审批；默认脱敏 PII。
- 新增运维端邮件/支付状态 API；Resend Webhook 现在读取原始 body、校验 Svix 签名、限制 body 大小并幂等保存已验证事件。
- 新增 Notification Worker 最小 PostgreSQL outbox 消费路径：只连接 `DATABASE_URL` 业务库，使用 `SKIP LOCKED`、租约、owner fencing、有限重试和 Resend 幂等键。
- 所有用户邮件统一使用 `noreply@agentnovas.com`；已配置的邮件模板和密码重置/内部账号验证链接均指向实际存在的页面。
- 新增 Payment Worker 与 Notification Worker 启动脚本，默认通过环境变量关闭；未满足完整配置时不发送邮件。
- 新增 Riverton systemd 与 Nginx 模板，仍为 Linux/Nginx/Certbot 直连，不使用 Cloudflare Runtime 或 Redis。
- 新增 ADR：`docs/adr/0005-riverton-three-app-rbac-wallet.md`。

仍未完成或明确受限：

- 尚未把根 `app/` 真实搬迁为三个完全独立的 Next 应用；当前是同一代码基线通过 audience、端口、Cookie 和构建目录隔离。
- RBAC 管理 UI 尚未实现；API 已有最小持久化骨架。审批 API 已在同一 PostgreSQL 事务中重新校验申请、应用已批准变更、写入决定和授权审计；拒绝不会改变权限。
- 真实 USDT 托管/支付服务商尚未选型，链上自动扫描、确认、入账和对账 Worker 仍是后续实现。
- Webhook 已完成签名验签和事件持久化，但尚未把 provider event 自动映射回 `notification_deliveries`；路由响应保持 `queued: false`，不伪称下游处理已完成。
- 未执行真实 Resend 外发；Worker 只有在生产环境开关、API key、业务数据库和 active/verified provider 配置同时满足时才会发送。

本次验证：

- `npm test`：225 项通过。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 error，保留 7 个既有 warning（`<img>` 和一个既有 effect 依赖提示）。
- `npm run build`：通过，包含 `/reset-password` 和 `/verify-email` 页面。
- `npm run test:apps`：客户端、运营端、运维端构建通过。
- `git diff --check`：通过。
- 未在本次验证中发送真实邮件、调用真实 Resend、执行生产数据库迁移或执行支付操作；尚未完成并发 PostgreSQL 审批/Worker 集成验收。
