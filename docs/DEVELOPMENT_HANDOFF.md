# AgentNovas 开发环境交接说明

> 2026-08-23 V3 文档同步：当前目标文档分支为 `codex/platform-v3-doc-sync`。需求方已确认完整三端平台 PRD V3.0；先阅读 `docs/DOCUMENT_STATUS_MATRIX.md`、`docs/product/PRD.md`、`docs/roadmap/FULL_PLATFORM_V3_ROADMAP.md` 和 `tasks/todo.md`。当前生产仍是 Beta/Paper 基线，真实交易、永续、提现/划转和 Maintenance 自动部署不得因目标文档存在而开启。

> 最新文档入口为 `docs/README.md`。本文第 13 节对前文“全部完成”的表述进行了状态校正；接管者应以最新 PRD、Spec、系统评估和任务清单为准。

## 1. 接管入口

本文档是新开发环境和新接管任务的第一入口。聊天记录不会自动随代码迁移，因此接管时必须依次阅读：

1. `AGENTS.md` 与 `CLAUDE.md`（不可违反的业务不变量 INV-1–INV-11、架构边界、已知陷阱）
2. `docs/README.md`（文档入口与按角色的阅读路径）
3. `docs/DOCUMENT_STATUS_MATRIX.md`（哪份文档是 Target、哪份是 Current，冲突时以谁为准）
4. `docs/product/PRD.md`（V3 目标产品真源）与 `docs/specs/SYSTEM_SPEC.md`（当前运行与硬关闭边界）
5. `tasks/plan.md` 与 `tasks/todo.md`（任务执行真源；注意两者的 Phase 4 编号不同，见 plan 的映射表）
6. 本文档**最新编号条目**（每个切片的实施与验证证据按时间追加，越靠后越接近现状）
7. 与当前切片相关的 ADR 和 `docs/specs/*`
8. `git log -1 --stat` 与 `git status --short --branch`

**本文 §3–§9 描述的是 2026-08-19 前后的历史交接内容，其中多数文件（`app/client-app.tsx`、
`app/globals.css`、`app/globals-beta.css`、`/workspace` 路由等）已在 P4 清理中删除。**
这些章节保留为历史记录，不是当前代码结构说明；现状以 §51 起的最新条目和上述文档为准。

当前工作分支见 `tasks/plan.md` 顶部；`codex/three-app-riverton-split` 是最后一个推送到 origin 的
分支，不是当前开发分支。交接版本以本文件所在的最新本地提交为准，不依赖未提交文件。

未经用户明确授权，禁止推送远程、创建 PR 或把仓库发布到任何托管平台。代码交接优先使用本地 Git bundle。

## 2. 不可改变的架构边界

- 目标部署为自有 Linux、Node.js 22.21+、PostgreSQL 16+、官方 spot-only Runtime Worker、Notification/Demo Worker、Nginx 和 Certbot。受邀付费 Beta 不启动 legacy Research Worker。
- 不使用 Cloudflare Runtime，不引入 Redis。Web 与 Beta Workers 以 PostgreSQL 为唯一持久化真源。
- 本期只提供策略研发、真实历史回测、影子盘和模拟盘；真实永续订单路由必须保持关闭。
- LLM 负责需求结构化、市场解释、独立提案、反方审查、风险说明和报告。DSL 校验、行情标准化、参数搜索、回测、评分、准入、风控和模拟订单意图由确定性代码控制。
- 回测是历史证据，不承诺未来收益。未达到门槛的候选必须明确标记 `NOT_QUALIFIED` 或“未通过标准验证”。
- 平台模型与平台 Demo 交易所密钥只在 Maintenance 控制面服务端加密保存，不进入浏览器、Agent 公开事件、日志或 Git。Client 不提供 BYOK、私有端点或客户交易所密钥上传。

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

Web 与官方 spot-only Runtime Worker 分别启动：

```bash
npm run dev
npm run worker:runtime
```

Worker 不是 Web 进程的子任务。仅启动 Web 可以浏览页面，但官方 spot paper 周期不会被消费。`npm run worker:research` 在 Beta 为硬关闭路径，不得纳入启动清单。

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
- Web 与官方 spot-only Runtime Worker 分别启动，健康检查和租约正常；Maintenance 对 legacy Research 显示 disabled。
- 商业披露、会员、credits、官方三卡、七阶段、paper 历史、影子盘和模拟盘至少各完成一次验收。旧永续 research 不进行功能验收，只验证不可达与存量取消证据。
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
- Webhook 的签名验签和事件持久化已在本切片完成；provider event 到 `notification_deliveries` 的自动映射已由第 11 节后续增量补齐。
- 未执行真实 Resend 外发；Worker 只有在生产环境开关、API key、业务数据库和 active/verified provider 配置同时满足时才会发送。

本次验证：

- `npm test`：225 项通过。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 error，保留 7 个既有 warning（`<img>` 和一个既有 effect 依赖提示）。
- `npm run build`：通过，包含 `/reset-password` 和 `/verify-email` 页面。
- `npm run test:apps`：客户端、运营端、运维端构建通过。
- `git diff --check`：通过。
- 未在本次验证中发送真实邮件、调用真实 Resend、执行生产数据库迁移或执行支付操作；RBAC 双审的并发 PostgreSQL 集成验收仍未完成，Notification Worker 集成验收见第 11 节。

## 11. 2026-08-20 Resend 投递状态闭环

在本地提交 `6931162` 之后继续完成通知生产闭环：

- Resend 发送请求增加 `notification_delivery_id` 标签；Webhook 可以在发送 API 响应回写前按本地投递 ID 安全关联，避免竞态丢事件。
- 已验证的 `email.sent`、延迟、送达、打开、点击、投诉、退信、失败和抑制事件会在同一 PostgreSQL 事务中持久化并映射回 `notification_deliveries`。
- 使用 `svix-id` 去重，以事件 `created_at` 和固定优先级处理乱序；旧事件不会回退新状态，标签与 provider message ID 冲突时不会更新任一投递。
- Webhook 只在事务提交后返回 HTTP 200；合法重复事件返回 200 但不会重复应用。畸形字段、错误发件人和无效签名继续拒绝。
- Worker 回写发送结果时保留 Webhook 已确认的 `delivered`/`failed` 终态；租约 fencing 失败时日志明确报告 `fenced`，不再伪报 `sent`。
- 新增幂等迁移 `0018_resend_delivery_events.sql`，记录供应商事件类型、事件时间、provider message ID、映射投递和处理时间，并增加唯一/查询索引。
- 部署模板补齐默认关闭的 `NOTIFICATION_EMAIL_SEND_ENABLED` 二次开关；上线手册增加 Resend 事件订阅、HTTP 200、重放和回滚验收步骤。

本次验证：

- `npm test`：235 项通过，包含真实本地 PostgreSQL 的并发重复、乱序、Webhook/Worker 竞态和冲突标识测试。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 error，保留 7 个既有 warning。
- `npm run test:apps`：客户端、运营端、运维端生产构建通过。
- `npm audit --omit=dev --audit-level=critical`：0 个漏洞；`git diff --check`：通过。

仍未执行真实 Resend 外发、生产 Webhook 注册或生产数据库迁移；这些操作需要生产域名、Resend 密钥和明确的发布授权。RBAC 双审的真实并发 PostgreSQL 集成验收也仍是独立后续项。

## 12. 2026-08-20 Riverton 三应用前端与运营闭环

在本地提交 `6931162` 之后继续完成“三应用一库”前端计划；本节改动和第 11 节 Resend 未提交改动均保留在当前工作区，尚未创建本地提交、推送远程或创建 PR。

已落地：

- 根页面改为服务端 audience 分发，客户端主体迁入 `apps/client/ui`；运营与运维分别使用 `apps/operations/ui`、`apps/maintenance/ui`，共享 Shell、状态组件、确认对话框、数据 Hook 与 Access Center。
- 三端稳定路由、独立登录页和 Cookie 已完成。运营端与运维端不显示注册/忘记密码入口；错误 audience 页面返回 404，未登录保留 `next` 参数，403 不循环跳转。
- 客户端补齐钱包余额/流水、充值创建/追踪和通知中心；支付服务未配置时显示真实 503 原因，不生成地址或二维码。
- 运营端补齐概览、客户、组织、充值、人工操作/双人审批、只读账本、财务、RBAC 和授权审计工作区。
- 运营客户、充值、账本和财务接口接入当前应用 RBAC 与数据范围；充值列表/详情使用一致 PII 脱敏，人工操作禁止自审和重复决定。
- RBAC 列表和变更强制按当前 audience 过滤；敏感角色创建/分配/撤销进入双审，批准后的草稿角色可填写原因后发布并写入授权审计。
- 运维端补齐系统健康、模型 Profile、Agent 绑定、邮件、支付、RBAC 和审计；API/UI 不回显密钥、完整端点或 Webhook payload，并准确区分“已配置”“已启用”“正在运行”和“已配置但未发送”。
- 作用域紧急暂停已收敛到官方 Paper canonical access：运维端按 PLATFORM/ORGANIZATION 范围拒绝待处理买入并把组合切换为 `close_only/read_only`；不发送订单、不联动平台 Demo，解除后也不自动恢复。
- 继承远端客服与品牌功能：运维端维护公开品牌、客服和公告字段，Telegram URL 强制 HTTPS 与域名白名单；客户端显示 Riverton Capital 和真实客服渠道，未配置时不生成虚假工单成功。
- `packages/contracts` 增加三端 UI 使用的 camelCase 响应合同、状态与格式化函数；组件不直接消费数据库 snake_case 行。

真实浏览器验收使用隔离 Chrome Profile 和一次性 PostgreSQL Schema 完成，覆盖 Client、Operations 申请人、Operations 审批人和 Maintenance 管理员。已验证三套 Cookie 隔离、充值未配置、PII 权限差异、资金操作第二人审批、角色应用隔离、模型/支付/邮件不泄密、键盘入口和 320/768/1024/1440 四档布局。唯一控制台错误是测试主动触发的预期支付未配置 503；测试服务已停止，一次性 Schema 已清理。

最终验证：

- `npm test`：259 项通过，包含三端 UI 合同、RBAC audience 隔离、数据范围、充值脱敏、审批冲突、Resend/PostgreSQL 并发、远端功能继承与原有客户端回归。
- `npx tsc --noEmit`：通过。
- `npm run lint`：0 error，保留 7 个既有 warning。
- `npm run test:apps`：Client、Operations、Maintenance 三端生产构建全部通过，每端收集 95 个路由。
- `git diff --check` 与新增文件尾随空白检查：通过。
- 最终安全审查补齐模型 API 回执裁剪、角色模板 UI、角色管理/分配/审批权限分离、直接撤销防绕过、Client-only 注册/找回、敏感测试原因审计和精确稳定路由。

仍保持的边界：

- 未启用真实永续订单、真实支付、邮件外发、自动资金执行或生产迁移。
- 组织树和部分历史财务写接口仍保留旧角色兼容来源；新三端页面只暴露已接入 RBAC/data scope 的读取与申请流程。

## 13. 2026-08-20 七智能体说明书对齐与系统评估

根据《七智能体动态策略系统_用户说明书》重新核对 Client 交易大厅后，确认第 12 节的“三应用前端完成”只代表基础页面和部分 API 切片完成，不能代表旧后台能力、七智能体产品合同、安全收口和生产验收全部完成。

本轮新增并作为最新真源：

- `docs/product/PRD.md`
- `docs/product/SEVEN_AGENT_TRADING_HALL.md`
- `docs/specs/SYSTEM_SPEC.md` 与三应用 Spec
- `docs/architecture/CAPABILITY_MIGRATION_MATRIX.md`
- `docs/review/SYSTEM_ASSESSMENT_2026-08-20.md`
- `docs/api/API_CATALOG.md` 与核心 OpenAPI
- `docs/quality/ACCEPTANCE_AND_RELEASE_GATES.md`
- `docs/roadmap/CONTROLLED_BETA_ROADMAP.md`
- ADR-0006/0007

关键校正：

- 三张官方策略卡目标为 BTC/ETH/SOL 的 USDT 现货；现有 1x 永续研究/回测属于独立模拟产品，不得冒充官方现货实盘。
- 七角色应为市场、技术、策略研究、反方、风险、AI 最终决策和执行；现有 runtime 的 `audit` 是 legacy 审计事件，不是 AI 决策官。
- 平台服务钱包仅支付会员/AI 服务，交易资金留在客户交易所。
- Client Hall 和 Meeting 已删除硬编码实时数据、fallback 业绩、静态会议和无行为紧急停止；无数据时显示真实空态。
- 该条为 `0762fa3` 历史审计结论：当时 131 个 API route 中仍有大量 legacy session/role 接口、Operations 旧能力未全部迁移、Maintenance Worker 健康缺真实心跳。当前以 181 route/233 method inventory、`tasks/todo.md` 和发布 Gate 证据为准。
- 当前测试仍包含大量源码合同；rendered HTML 已不依赖 ignored/stale `dist`，CI 增加了真实 production HTML 冒烟。

本轮七智能体代码切片：

- `packages/contracts/src/trading-hall.ts` 固定七角色、三卡参数、现货产品边界和决策轮完整性。
- Runtime 新周期按市场、技术、策略、反方、风险、AI 最终决策、执行顺序记录；旧 audit 只作为 legacy 审计证据。
- `/api/trading-hall` 仅返回显式安全字段，不返回原始 runtime payload；Hall/Meeting 使用真实接口和空/错/加载状态。
- Client 首屏与策略广场同步使用七角色/三卡真源，删除静态报价、风险指数、延迟、假在线状态、假走势图和预计月化目标。
- `0020_runtime_final_decision.sql` 兼容旧 audit 并允许新 `decision` 事件；只在本地测试库执行，未执行生产迁移。
- 全量 268 个测试、TypeScript、Lint、三端构建和 Client production HTML 冒烟已通过；Lint 保留 7 个既有 warning。

`tasks/todo.md` 已改为 CURRENT/PARTIAL/TARGET/BLOCKED 证据状态。未经后续 Gate 验收，不得再对团队宣称“三端全部完成”或“生产就绪”。
- 真实支付服务商、链上扫描/入账、自动对账、客服工单、自动导出和功能开关编辑不在本阶段扩展范围。
- 当前 lint 保留 7 个既有 warning；没有新增全局忽略规则。

运行、路由、权限和验收说明见 `docs/runbooks/riverton-three-app-ui.md`。

## 14. 2026-08-20 受邀付费 Beta v2 收口

第 12、13 节记录的是历史阶段证据，不能覆盖当前 v2 PRD。最新目标已收窄为 5–20 人受邀付费 Beta：

- 客户不再连接交易所或上传密钥；每张官方策略使用独立 10,000 USDT paper 组合。
- 平台 OKX Demo、Binance Spot Testnet、Bybit Demo 只提供测试环境证据，与客户 paper 状态/盈亏/结算分离。
- 四档会员使用版本化计划；外部人工付款、站内凭证、不同 Operations checker 复核后才激活权益并发放 credits。
- UTC 周 paper 盈利分成按三卡已平仓净收益、高水位和亏损结转生成；业务审批只形成应收，付款复核后才提交高水位。
- Client 仅开放优盾 USDT deposit-only 充值：真实地址、验签回调和 Ops 双审入账；二维码、Credits 充值、提现/划转、Telegram/WhatsApp 验证、客户交易所连接、真实订单、自动扣款/退款关闭。
- `0029_beta_legacy_runtime_hard_close.sql` 终结存量非 spot deployment、取消非终态 legacy research run 并写审计；发布时必须先手动停止已运行的旧 Research Worker，新 unit 不会代停旧进程。
- 内部端采用 Argon2id、TOTP/recovery、recent MFA、中央 API Policy、显式 assignment/scope；具体完成度以 `tasks/todo.md` 和 Gate 证据为准。
- `0038_client_ai_runtime_credits.sql` 将 Client AI 收敛为平台 Profile 安全投影、可靠 usage、Credits 原子预留/结算和持久化幂等；Client BYOK 已硬关闭。迁移环境必须保留与既有密文匹配的 `LLM_PROFILE_ENCRYPTION_KEY`。
- `0039_maintenance_idempotency.sql` 为公共源测试和紧急停控绑定 actor/subject/payload/幂等键哈希，重放只返回持久化终态，超时进入人工核对而不是重复执行。
- `0040_client_identity_rls.sql` 撤销 Client 对身份与邀请表的直接访问，将 Client Web 自助流程和 Client Auth 登录投影拆成两组不可链式调用的数据库 capability gateway；部署必须提供独立 `DATABASE_URL`/`CLIENT_AUTH_DATABASE_URL` 并运行角色策略与过期 session 攻击测试。
- `0043_client_identity_gateway_hardening.sql` 收敛升级库中遗留 ACL：五张身份表强制 RLS，未知角色不再通过反向条件获得可见性，Client Web/Auth 只能执行各自的精确 gateway；Web 和 Worker 连接在运行时同时核验 URL 角色与 `current_user`。

本轮主 Agent 已先形成独立提交：版本化 PostgreSQL 迁移器、Argon2id 依赖、商业公共合同、Worker heartbeat 与公开/内部 health 分层。Wave 1 使用本地 worktree 并行实现 API Security、Commercial 和 Strategy Demo；所有子分支只在独立审查后通过普通 `merge --no-ff` 合入集成分支。

最新阅读顺序：`docs/product/PRD.md` → `docs/product/SEVEN_AGENT_TRADING_HALL.md` → `docs/specs/SYSTEM_SPEC.md` → 三端 Spec → ADR-0008 至 0012 → API Catalog/OpenAPI → Acceptance Gates → Runbooks → `tasks/todo.md`。

平台产品身份、服务地区、隐私、条款、风险、Paper 收费和退款/不退款规则任一未通过商业披露 maker-checker 发布，或用户未确认仍能启动 trial/下单，均不得开放付费 Beta。Email/Demo/DNS/TLS 未配置时必须显示未配置并关闭外部副作用；如发布目标包含这些渠道，则相应 staging smoke 必须另行通过。本实施不执行生产数据库迁移、真实支付、真实交易、真实退款或未授权外部基础设施变更。

## 15. 2026-08-21 不可变版本管理与发布收口

- `0041_release_version_management.sql` 增加 Maintenance-only 的版本、验证和部署三类追加事实；触发器禁止更新/删除，Client/Operations 无数据库访问。
- `/api/maintenance/releases` 及验证/部署子路由使用显式 RBAC、recent MFA、Origin、幂等键、严格输入和审计；创建者不能自审。
- `/releases` 只记录 Git/构建/迁移身份和外部发布结果，不执行 SSH、迁移、切流、Git tag 或回滚。
- production succeeded 要求同版本 staging succeeded；failed 不改变 current，rollback 目标必须曾在同环境成功部署。
- Production HTML smoke 已修正随机端口 audience 映射，并按未登录会话验证边界断言，避免远端 CI 在严格 Host/audience 策略下超时。

## 16. 2026-08-21 Resend 邮件生产闭环校正

- 事务通知发件人固定为 `noreply@agentnovas.com`；四个业务联系地址仅作保留身份，在真实收件验收前不作为客户支持渠道宣传。
- Notification Worker 独占 `RESEND_API_KEY` 与 Beta allowlist，Maintenance Web 独占 `RESEND_WEBHOOK_SECRET`；Client Auth 与 Notification Worker 通过受保护部署配置共享通知令牌加密密钥，所有值均不得进入 Git 或 UI。
- Worker heartbeat 只发布 API Key、allowlist、令牌密钥和发送开关的布尔就绪证据，Maintenance 不跨进程读取 Worker 密钥环境。
- 运维端邮件测试已从“只记录配置”改为真实 outbox 入队；Provider Gate、Worker 就绪、投递、最近测试时间和审计处于同一事务，同请求 ID 重试不重复投递。
- `queued` 不代表已发送或已送达；最终状态必须来自 Notification Worker 与通过 Svix 签名验证的 Resend Webhook。
- Resend 发件域已验证；一次性 Sending access Key 对官方 `delivered@resend.dev` 测试地址的受控发送已被 Provider 接受，测试后本地临时环境文件已删除。该 Key 曾进入会话记录，必须撤销且不能部署；Webhook 尚未创建，`xm.agentnovas.com` 仍返回 525，因此不得把 accepted 描述为 delivered，运行状态继续保持 `configured_not_sent`。

## 17. 2026-08-22 `v1.0.0-beta.2` 自托管部署

- `v1.0.0-beta.2` / `5b7e2b063800b9c7c2e40159893650035ff20cc5` 已以 Client、Operations、Maintenance、Runtime 四张 `linux/amd64` 版本化镜像部署到 `an-saas`；三端和 PostgreSQL healthy，三端正式域名登录与 readiness 均为 HTTP 200。
- 当前 release 为 `/opt/agentnovas-riverton/releases/v1.0.0-beta.2-5b7e2b0`，previous 为 `v1.0.0-beta.1-b5befdc`；PostgreSQL volume 未删除，迁移 registry 共 43 项、最新 `0042`，数据库角色策略为 0 findings。
- Notification Worker 运行但真实 Email send 关闭；Payment、Demo 和策略外部执行保持关闭，优盾未配置。不得把进程 running 描述为 Provider 已发送、已支付或已成交。
- 发布控制面仍为 0 条版本/验证/部署事实：缺少第二名 Maintenance checker 和同版本 staging succeeded 前置事实，因此没有伪造 production succeeded。
- 本次发现 `release:build-images` helper 缺少 `--file deploy/container/Dockerfile`；在修复和测试前，必须使用 tag workflow，或在服务器从精确 tag/commit 显式指定该 Dockerfile 构建。
- 完整发布身份、CI run、镜像 ID、部署步骤、TLS/Host smoke、回滚目标、异常和下一版本行动项见 `docs/releases/2026-08-22-v1.0.0-beta.2-deployment.md`。本文第 9 节“尚未生产部署”是历史阶段描述，不再代表当前状态。

## 18. 2026-08-22 `v1.0.0-beta.3` 公开着陆页修复发布

- `v1.0.0-beta.3` / `d6b60f2f977ffde06075028a274684c4e24332fe` 已部署到 `an-saas`；Client 根路径恢复公开 Riverton Capital 着陆页，真实 Chromium 等待 hydration 后仍保持 `/`，不再跳转 `/login?next=/`。
- Client、Operations、Maintenance healthy，Notification Worker running，PostgreSQL healthy 且切换前后 container ID 不变；本次没有执行 migrator、生产 schema 迁移或 volume 操作。
- `current` 为 `/opt/agentnovas-riverton/releases/v1.0.0-beta.3-d6b60f2`，`previous` 为 `/opt/agentnovas-riverton/releases/v1.0.0-beta.2-5b7e2b0`；前一版本 Compose 回滚配置已复核有效。
- Email external send 仍为 disabled，Payment、Demo、Strategy Runtime Worker 均 absent；真实支付、客户充值、外部 Demo 写入和真实交易继续硬关闭。
- 320px 真实浏览器下 Logo、登录按钮、语言切换和主 CTA 可见，无横向溢出；桌面端 console warning/error 为 0，三端正式域名与 audience 404 合同通过。
- 完整发布身份、四镜像 ID、archive/manifest/evidence 摘要、数据库事实、浏览器证据和回滚步骤见 `docs/releases/2026-08-22-v1.0.0-beta.3-deployment.md`。

## 19. 2026-08-22 三端验收账号与生产配置工具

- `scripts/provision-acceptance-accounts.mjs` 在一次事务内创建 Client、Operations、Maintenance 三个独立验收身份、固定 custom role、当前 audience 全量显式 permission 和审计；密码由进程随机生成，只写入 root 挂载的 `0600` 文件。Operations/Maintenance 首次登录必须独立绑定 TOTP。
- 创建器不会重置已有账号/role，不在参数、stdout、数据库或审计中保存密码；重复执行、邮箱冲突、多个 active `hq_admin`、权限目录缺失或 Headquarters 歧义均失败关闭。
- `scripts/audit-production-config.sh` 只报告核心配置、Resend、优盾与危险开关状态，检查 Client/Operations/Maintenance/Worker 共享加密值一致性，不输出任何配置值。
- `scripts/install-production-integrations.sh` 从仓库外 `0400/0600` 填空文件读取 Resend/优盾输入，拒绝未知、重复、部分或无效字段，逐文件原子替换现有 env；安装后仍强制 Email send、Payment Worker、Provider test 和 Demo 外部写入为关闭。
- `scripts/record-email-provider-readiness.mjs` 只记录域名、Webhook、模板、suppression 和收件邮箱是否完成的非秘密事实；`activate` 要求四个外发 Gate 全为真，不改变 Notification Worker 发送开关。
- `scripts/provision-platform-demo-credentials.mjs` 只从固定 root-only JSON 读取 OKX/Binance/Bybit 测试凭证并加密入库；新建和轮换均强制 `enabled=false`、开启账户/卡片 kill switch、清除旧验证，且不会联网、启 Worker 或打开外部写。
- 完整账号创建、密码取回、首次 MFA、Resend、优盾、LLM、Demo、服务重启、验收和安全清理步骤见 `docs/runbooks/production-accounts-and-configuration.md`。
- 当前生产核心 secret 已配置且跨进程一致；待外部输入仍为新 Resend Key/Webhook/allowlist、优盾商户参数、模型 Profile/绑定和三交易所 Demo 凭证。未提供时必须保持真实的 `incomplete/configured_not_sent/disabled`。
- 三端验收账号已在生产原子创建并通过正确 audience 登录、错误 audience 拒绝和单 audience RBAC 验证；Client/Operations/Maintenance 分别投影 9/34/22 项权限，验证 session 已撤销。密码只保存在服务器 root-only 交付文件，首次 Operations/Maintenance 登录仍须完成各自 TOTP enrollment。

## 20. 2026-08-22 Client 客户交易工作台修复

- `/` 固定为公开 Riverton Capital 着陆页；认证后的稳定入口改为 `/dashboard`。Client 登录默认目标、Logo、面包屑和产品导航均不再指向 `/`。
- 客户端不再复用内部 `ConsoleShell`，而是使用交易总览、交易大厅、模拟组合、会员、策略实验室、Credits、账单和资产服务组成的独立客户 Shell；菜单仍由 `/api/access/me/effective` 过滤。
- `/dashboard` 以服务端返回的三卡 Paper 权益、已实现/未实现收益、策略运行状态、会员、Credits、账单和通知为首屏，不使用静态 KPI 或假收益。
- `/workspace` 继续按需加载旧策略/Agent 能力，但嵌入同一客户 Shell，不再渲染第二套顶栏、侧栏或等待内部会话时的登录页。
- 商业披露仍版本化保存，会员订单创建继续要求当前七份正文；会话、Paper、行情、通知、钱包只读和账户安全不再受全局披露重定向。决策见 `docs/adr/0017-client-dashboard-and-scoped-commercial-disclosures.md`。

## 21. 2026-08-22 `v1.0.0-beta.5` Client 身份边界生产发布

- `v1.0.0-beta.4` 在生产 Client 账号 smoke 中发现 Credits 投影仍 join FORCE RLS `users` 表并返回 500，因此没有登记为 current；未修改 beta.4 tag，另发不可变 `v1.0.0-beta.5`。
- beta.5 将 Credits、商业披露确认和优盾充值订单三条 Client 路径从直接身份表访问中移除；无 Credits 账户返回零余额和空更新时间，不制造 1970 占位时间。
- 最终 776 项测试、TypeScript、Lint、三端 production build、bundle、secret scan、production dependency audit、44 migration rerun、PostgreSQL role policy 和四个实际进程 DB role 全部通过。
- 生产 root-only 三端凭据完成真实登录：Client 9 项权限与 Dashboard/交易大厅/Paper/Workspace/会员/Credits/通知/钱包 API 通过；Operations/Maintenance 正确要求首次 TOTP；跨 audience 返回 403 且不写 Cookie。smoke sessions 已撤销。
- 公网 Chromium 在 320/768/1024/1440 下无横向溢出，三端登录与未登录 Dashboard guard 通过，console warning/error 为 0；公开 HTTPS 返回 nonce CSP、HSTS、Permissions-Policy、Referrer-Policy、nosniff 和 frame deny。
- 生产 `current` 为 `/opt/agentnovas-riverton/releases/v1.0.0-beta.5-5fa58b2`，`previous` 为已验证的 beta.3；beta.4 仅保留复盘，不是回滚目标。release 目录已 root-owned 只读。
- 配置审计真实状态为 core ready、Resend incomplete、Udun incomplete、Email send disabled；LLM Profile、三平台 Demo 账户均为 0，Udun provider disabled 且无 secret。完整证据见 `docs/releases/2026-08-22-v1.0.0-beta.5-deployment.md`，配置步骤见 `docs/runbooks/production-accounts-and-configuration.md`。

## 22. 2026-08-22 三端前端设计系统重构（第一阶段）

对标 new-api 现行的 shadcn/Tailwind v4 视觉体系（16px 大圆角、48px 紧凑顶栏、
浅色默认 + OpenAI 风格炭灰暗色、极浅描边不用阴影分层），把三端统一到同一套设计令牌。
本阶段只做设计系统与外壳，不动业务逻辑与数据流。

### 新增

- `app/design-tokens.css`：全平台唯一色彩真源。浅色默认 + `prefers-color-scheme` 跟随系统
  + `[data-theme]` 显式选择三态。保留 `--rc-*` 兼容别名层，存量引用改完后可整段删除。
- `packages/ui/src/icon.tsx`：38 个 24×24 / 1.7px 描边图标，取代导航里的 Unicode 与汉字占位
  （`⌂ ◈ 客 组 队`），这些字符在 macOS / Windows / Android 上字形差异极大且无法统一尺寸。
- `packages/ui/src/theme-script.ts`：主题引导脚本，**刻意不含 React / JSX / "use client"**。
  `app/layout.tsx` 被所有页面共享，从客户端组件模块 import 常量会把整个模块（含全部图标）
  拖进公共包，直接顶爆 client 的 JS 预算。
- `packages/ui/src/theme-toggle.tsx`：用 `useSyncExternalStore` 订阅 `data-theme` 属性与
  媒体查询，而不是在 effect 里 setState —— 后者会级联渲染，也读不到首帧前内联脚本写入的属性。

### 重写

- `app/riverton-console.css`：全量重写（1226 行）。`rc-*` 类名 100% 保持，一次性重设计
  Operations 15 页 + Maintenance 15 页 + 登录页。**零硬编码色值**。
- `packages/ui/src/console-shell.tsx`：分组侧栏（264px）+ 48px 顶栏 + 主题切换 + 移动抽屉。
- `apps/client/ui/client-portal-shell.tsx` / `.module.css`：同一设计语言，但**结构独立**。
  `tests/riverton-ui-contract.test.mjs` 明确禁止客户端复用内部控制台外壳、禁止出现
  `href: "/"`（"/" 是公开落地页），这是产品边界，本次遵守而非推翻。
- 客户端 5 个工作区样式表：247 个一次性色值按角色（chroma + 亮度）归并到令牌；
  圆角从 14 种取值收敛到 3 档；25 处 <12px 字号提到 12px 下限。

### 契约变更

- `ConsoleNavigationItem[]` → `ConsoleNavigationGroup[]`，新增 `visibleNavigationGroups()`
  与 `flattenNavigation()`。分组只影响视觉结构，权限仍逐条落在 `item.requiredPermissions`。
- 因此把 `tests/riverton-ui-contract.test.mjs` 中 `visibleNavigation(navigation, …)` 的断言
  改为 `visibleNavigationGroups(navigation, …)`，仍然校验按权限过滤。**这是本次唯一改动的测试断言。**

### 修复的既有缺陷

- `app/globals-beta.css` 有 5 条 `body{…!important}` 深色规则。该文件会被打进登录页与
  Portal 共用的 CSS chunk（既有分包问题），`!important` 压过令牌背景，使浅色主题在这些页面
  完全失效。已限定为 `body:has([data-app-shell])` —— 遗留页面的深色本来就由
  `.app-shell`（`min-height:100vh` + 自带背景）承担，这些 body 规则对它们是冗余的。
- `app/base.css` 写死的 `color-scheme: dark` 已移除，改由令牌层按主题声明。

### 验证

TypeScript、ESLint、776 项测试、三端 production build、bundle budget 全部通过。
CSS gzip：Operations / Maintenance 从约 90.9KB 降到 **11.3KB**；Client 45.2KB（预算 51.2KB）。
生产服务器实测 `/login` 与 `/` 的浅色、暗色、跟随系统三态取色正确，遗留落地页深色未受影响。

### 已知问题与下一步

- **Client JS 余量仅 164 字节**（204,636 / 204,800）。根因是既有分包问题：公开落地页会下载
  约 14KB 它永远用不到的 Portal 外壳 JS（`1_1oxtmfhx8hx.js` 同时含 theme-script、图标和
  client-portal-shell，但不含落地页自身代码）。这是系统评估第 13 条「三端同包」的一部分，
  修好可释放约 14KB。在此之前任何客户端新增代码都要先跑 `npm run quality:bundle`。
- `npm run test:smoke` **在本次改动前即为失败**：它断言 `/` 返回「正在验证客户端会话」，
  但 client audience 的 `/` 渲染的是公开落地页。已用 stash 对比基线确认非本次引入。
- 遗留 `/workspace` SPA（`app/client-app.tsx` 2506 行、`globals.css` 3871 行）未动，仍是旧视觉。
  `LocaleGuard` 因此保留——它只挂在该路由上，现在删除等于在无替代方案的情况下移除多语言。
  这两项属于 P2/P3，需单独排期。

## 23. 2026-08-22 P0 地基与护栏

架构重构的第一阶段。不改代码结构，先立规矩：把「靠约定和 code review 保证」的
边界变成「机器强制」。项目由单人 + AI 协作开发，没有第二双眼睛，这一步优先于
一切实际重构工作。

分支 `refactor/foundation`，未推送。

### 交付

**CLAUDE.md（新）** —— 原文件只有一行 `@AGENTS.md`。现在包含 10 条不可违反的业务
不变量（逐条标注强制方式：数据库触发器 / 代码 / 测试 / 仅约定）、架构边界、
验证命令、已知陷阱、遗留代码清单、文档真源索引与术语表。

**审计防篡改（迁移 0044）** —— 0022 已锁死资金表，但审计侧此前无保护：
`audit_logs` 和 8 张 `*_decisions` 表可被有写权限的人改或删。`*_decisions` 正是
证明双人复核发生过的记录，能伪造就等于 INV-3 失效。新增哈希链 + append-only
触发器 + `verify_audit_log_chain()`。

**Nginx per-vhost API 白名单** —— 把跨端边界从 234 个 handler 前移到边缘。
从 inventory 用前缀树生成：只有整棵子树属于该 audience 时才合并。
最初按 `/api/<group>/` 粗粒度合并，实测让公网 vhost 放行 10 个 RBAC 管理接口，
合计 27 条越权路由，因此改用前缀树，现为越权 0 / 误拦 0。

**架构边界检查** —— 5 条 CI 规则：跨 audience import、资金表唯一写入口、
根 layout 包体纯净、遗留代码不扩散、样式层零硬编码色值。每条都配了「故意制造
违例能被抓到」的测试——从不报警的检查器等于没有。

### 事实更正

写 CLAUDE.md 时逐条核实断言，推翻了两处此前基于 `SYSTEM_ASSESSMENT` 的判断。
该文档第 1–5 节是起点 `0762fa3` 的快照，开头已注明不代表现状，但此前被当作现状引用：

- **账本的数据库级保护已存在**（0022），不是缺失。原计划的 P0「账本 DB 约束」
  因此换成了真缺口「审计防篡改」。
- **API inventory 的漂移检查已接入测试**，不需要人工登记。

引用该评估前必须先到代码或迁移里验证。此事已写入 CLAUDE.md 的已知陷阱。

### 验证

TypeScript、ESLint、793 项测试（+17）、三端 build、bundle budget、架构边界全部通过。
迁移 0044 在一次性数据库上完成全量 45 个迁移的验证（45 applied, 0 skipped）后删除，
未触碰任何既有数据库。

### 未验证

**生成的 Nginx 配置未经 `nginx -t` 语法验证** —— 本机无 nginx，Docker 守护进程未运行。
部署前必须先跑 `nginx -t`，并把 `deploy/nginx/generated/*.conf` 放到
`/etc/nginx/riverton/generated/`。

### 已知局限

哈希链检不出「截断链尾」——这是哈希链的固有性质，不是缺陷。需要把链尾哈希定期
外送到本库之外（备份、日志系统或运维端存档）。已在测试中显式记录为预期行为，
GA 前需补这个运维动作。

## 24. 2026-08-22 P1 纯域层抽取（第一阶段）

把核心业务逻辑从 `lib/` 的框架与仓储耦合里解放出来，并为真实交易 + 策略跟单
留出执行缝。分支 `refactor/foundation`，未推送。

### 迁移判定

按「是否做 I/O」逐个甄别，过程中纠正了三处误判：

- `exchange-adapters` 与 `research-agent` 看似零依赖，实则用
  `options.fetchImpl ?? fetch` 的注入式写法发真实请求，属于适配器层，不进域层。
- `performance-fee-service` 原以为需要拆分，实际上高水位线计算早已抽到
  `commercial-membership-domain.ts`，服务文件剩下的是编排与持久化，本就该留在 `lib/`。
- `strategy-runtime-engine` 移入后又退回：它的依赖链
  （`platform-strategy-v3` → `platform-ai-strategies` → `market-data` →
  `public-market-source`）底部是 I/O，强行搬会违反边界规则或拖一条以 I/O 结尾
  的链进来。等 `market-data` 端口化后再处理。

`research-errors.ts` 刻意不迁：`ResearchApiError` 带 HTTP `status` 字段，
是传输层语义。依赖它的 `release-version-domain` 因此一并推迟——改错误类型会
影响状态码，属于行为变更，不该混在搬迁里做。

### 已迁入（约 2,450 行）

`strategy-dsl`(949)、`backtest-engine` 纯计算部分(662)、`research-validation`(237)、
`official-paper-portfolio`(232)、`follow-policy`(65)、`commercial-membership-domain`(65)、
`business-rules`(58)；`packages/ledger/src/ledger.ts`(51)。

`backtest-engine` 按既有的缝拆开：`loadBacktestCandles`（取数）与
`runBacktestOnCandles`（纯计算）本就分离，取数与编排 50 行留在 `lib/`。

### 新增执行缝

平台的目标形态是真实交易 + 策略跟单，执行层是主干而非 GA 时才接的东西。

- `OrderIntent` 是纯值：不知道交易所、不知道凭证、不知道签名；带决策轮溯源
  （`decisionRoundId` / `traceId` / `contractHash` / `candleId`）兑现 INV-8 的幂等要求。
- 用「目标仓位比例」而非绝对数量：跟单场景下每个客户本金不同，同一条意图扇出到
  N 个组合各自换算，换算在执行端进行，域层不知道任何客户余额。
- `ExecutionPort.execute` 设计成批量：一轮决策扇出到该卡全部订阅组合，
  5000 会员即 5000 次调用，限流/重试/部分失败/对账是执行端责任。
- `resolveOrderQuantity` 取「意图目标比例」与「组合上限比例」中更严格者——
  客户设定的上限永远不能被策略意图突破。

### 机器强制

新增架构边界规则「域层不做 I/O」，覆盖 `packages/domain/src` 与 `packages/ledger/src`：
禁止 import `next` / `pg` / `drizzle-orm` / Node I/O 模块，禁止直接调 `fetch`，
禁止反向依赖 `lib/`。配三条「故意制造违例能被抓到」的测试。

### 文档

`packages/domain/CLAUDE.md` 与 `packages/ledger/CLAUDE.md` 记录各自的硬规则与
对应的 INV。其中一条来自实测：仓库用 `node --experimental-strip-types` 跑脚本与
测试，strip-only 模式不支持 TypeScript 参数属性、enum、namespace，运行时会抛
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。

### 验证

tsc、lint、810 项测试、三端 build、bundle 预算、6 条架构边界全部通过。

### 下一步

`packages/domain/src` 迁完这批是 2,483 行（`packages/ledger/src` 另 51 行）。
剩余待迁的是混了 I/O 的大件，需要先端口化：
`ai-credit-service`(497，reserve/settle/release 语义)、
`strategy-runtime-worker`(548，决策轮调度与七阶段编排)、
以及 `market-data` / `research-steps` 端口化之后的 `strategy-runtime-engine` 依赖链。


## 25. 2026-08-22 P1 AI Credits 账本规则抽取

`lib/ai-credit-service.ts` 是 I/O 混合件的第一个：算术与状态判定夹在 SQL 之间。
搬迁的是判定，不是查询——事务、锁、幂等行比对留在服务层。

### 迁入 `packages/domain/src/credits/credit-ledger.ts`（126 行）

| 函数 | 规则 |
| --- | --- |
| `isValidCreditMutation` | 五种变更各自允许的资金流向，credits 版的「借贷必平」 |
| `applyCreditDelta` | 余额应用；任一余额变负返回 `null`，不夹到 0 |
| `resolveReservationTransition` | 预留状态机：终态重放 / 活动态执行 / 跨终态冲突 |
| `planReservationSettlement` | 按实耗退回未用部分；超预留拒绝，不自动补扣 |
| `planReservationRelease` | 整笔原路退回 |

### 域层返回决策，服务层抛错误

这批刻意没让域层抛业务错误。`lib/client-ai-inference-service.ts` 靠
`error.message === "AI_CREDIT_INSUFFICIENT"` 把余额不足映射成 HTTP 402——
错误身份是既有的对外契约。域层不该知道 402，也不该沿用一个为 HTTP 映射服务的
message 约定。分工写进了 `packages/domain/CLAUDE.md`：
**域层判定「合不合法」，服务层决定「客户看到什么」。** 结果是零行为变更。

返回 `null` / `{ ok: false, reason }` 与硬规则 6「不 catch 后静默降级」不矛盾：
规则 6 禁止的是悄悄返回一个差不多的值，而显式失败结果调用方无法忽略。

### 一处判断修正

原打算在 `planReservationSettlement` 里挡负成本，去掉了：负成本产生的 delta 会让
credits 总量增加，本来就会被 settle 形状规则拒绝（`AI_CREDIT_MUTATION_INVALID`）。
多加一道会改掉错误码，也让同一条规则有两处真源。

### 覆盖变化

`tests/domain-credit-ledger.test.mjs` 12 项，不需要数据库。

此前这套算术只能通过 `*-postgres` 测试间接验证。那些测试确实会跑（连本地库、
建临时 schema），但每验一条规则要付出建表 + 事务的代价，于是实际只覆盖主干路径：
「settle 退回额超过预留」「adjust 动了预留」这类形状违例从没被直接测过，
而它们正是扣错钱的方式。

### 验证

tsc、lint、822 项测试、三端 build、bundle 预算、6 条边界通过。
另用本地 Postgres 单独跑 `tests/postgres-commercial-settlement.test.mjs`（20 项，
含 credits settle 与 `AI_CREDIT_INSUFFICIENT` 断言）确认端到端行为未变。

### 下一步

P1 只剩 `strategy-runtime-worker`(548)。它比 credits 难：credits 是「算术夹在 SQL
之间」，worker 是「七阶段编排夹在调度、心跳、重试之间」，切分点要先定义决策轮的
阶段推进规则才能找。`strategy-runtime-engine` 仍被 `market-data` /
`research-steps` 的 I/O 依赖链挡住，需要先端口化。


## 26. 2026-08-22 P1 决策引擎迁入域层

### 一处判断修正

§24 写的「`strategy-runtime-engine` 被 `market-data` / `research-steps` 的 I/O
依赖链挡住」是错的。逐文件核查后：三个模块都没有 `fetch`、没有 `.query()`、
没有 `Date.now()`、没有随机数。挡住它们的是**两个 import 说明符**：

- `platform-ai-strategies` 从 `market-data` 引的是 `import type { SpotCandle }`。
  类型导入在运行时被擦除，根本不产生依赖。
- `platform-strategy-v3` 从 `research-steps` 引的 `hashResearchStepInput` 是
  `canonical()` + `crypto.subtle.digest`，纯函数，只是恰好和几个
  `database.query` 住在同一个文件里。

教训写进了 `packages/domain/CLAUDE.md`：判断一个模块该不该进域层，
看它自己做不做 I/O，不是看它住在哪个文件里。

### 迁入（+770 行，域层合计 3,279 行）

| 模块 | 行数 | 内容 |
| --- | --- | --- |
| `canonical-hash.ts` | 50 | 规范化 JSON + SHA-256，幂等性的地基 |
| `platform-ai-strategies.ts` | 247 | 三张官方策略卡的定义与评估 |
| `platform-strategy-v3.ts` | 194 | 官方现货策略规格的规范化 |
| `strategy-runtime-engine.ts` | 179 | **七阶段决策评估** |

`evaluateStrategyRuntimeCycle` 现在可以脱离数据库、脱离 Next、脱离交易所直接跑。
这是「可解释、可审计的决策过程」这句话的兑现处。

### 两个命名/边界决定

- `hashResearchStepInput` → `canonicalJsonSha256`。旧名字只描述了它的第一个用途，
  实际上决策轮幂等、研发步骤检查点、DSL 合同哈希用的都是它。
  `tests/domain-canonical-hash.test.mjs` 钉死了一个已知摘要——改算法会让所有历史
  检查点行失效。
- 域层不复用 `lib/market-data.ts` 的 `SpotCandle`，改用 `strategy-dsl.ts` 的
  `StrategyCandle`。两者当前结构完全一致，但前者是公开行情源的传输形状，
  域层不该依赖「线上格式永远不变」。

### 验证

tsc、lint、830 项测试（+8）、三端 build、bundle 预算、6 条边界全部通过。
零残留引用。

### 已实施（第 2 步）：`safeRiskState` 改为失败安全

`lib/strategy-runtime-worker.ts` 的 `safeRiskState` 在风控读数非有限时静默取 0。
回撤取 0 等于「账户从未亏损」，结果是**更容易开仓**——方向与 INV-7 相反。

**已改为失败安全**，见 §27。实施时把方案改进了一处：不复用 `halted`，
而是单列 `unavailableFields`——熔断是风控生效，读数损坏是风控失效，
运营端看到这两种情况要做的事不同，混在一起会显示成「已触发熔断」。

安全性前提已核实：`strategy-runtime-engine.ts` 中
`riskApproved = action === "exit" || action === "hold" || 无拒绝理由`，
所有风控检查都只作用于开仓，平仓无条件放行。因此 `halted: true` 不会把客户困在仓位里。


## 27. 2026-08-22 P1 运行时判定抽取 + 风控读数改为失败安全

`lib/strategy-runtime-worker.ts` 548 → 494 行（净减约 70 行逻辑，另加 15 行 import）。
租约、心跳、快照、扇出、记账留在原处；判定进 `packages/domain/src/runtime/`。

### 迁入

| 模块 | 内容 |
| --- | --- |
| `cycle-planning.ts` | 选 K 线、周期 id、轮询节奏、资金费率窗口、现货行情严格校验 |
| `risk-state.ts` | 风控读数归一化（**行为变更，见下**） |
| `deployment-overrides.ts` | 部署级覆盖只能收紧 |
| `explanation-retry.ts` | 解释任务失败分类与退避 |

`selectCycleCandle` 消掉了一处重复：选 K 线的逻辑此前在现货与永续两条路径里
各写了一份，两份当时一致但没有任何机制保证继续一致。

### 行为变更：风控读数失败安全（INV-7）

原写法 `Number.isFinite(x) ? Math.max(x, 0) : 0`——回撤取 0 等于「账户从未亏损」，
风控因此看到一个完美健康的账户并放行开仓。**读数越坏越容易开仓**，方向与
失败安全相反，且悄无声息。

现在损坏字段记进 `unavailableFields`，引擎据此拒绝开仓并写明是哪个字段。

三个设计决定：

1. **不复用 `halted`。** 熔断是风控生效，读数损坏是风控失效。合并会让运营端
   看到「已触发熔断」而实际只是数据坏了，两者的处置动作完全不同。
2. **缺失按 0，损坏才算不可用。** 0007 号迁移的 `risk_state_json` 默认值包含
   全部三个字段且列是 NOT NULL，所以缺失只可能出现在从未写入的新部署上——
   新部署的回撤确实是 0，这是真实读数不是猜的。「算出了一个值而这个值是错的」
   才是危险情况。
3. **不能用 `Number(value)` 判可用性。** 写测试时发现 `Number([]) === 0`
   会让空数组被当成「没有回撤」溜过去，`false` 与 `""` 同理。改成先判类型
   （只接受数字与非空数字字符串）再转换。

**平仓不受影响。** 引擎里
`riskApproved = action === "exit" || action === "hold" || 无拒绝理由`，
所有风控检查都只作用于开仓。有断言钉住这条：读数全坏时平仓仍然放行且照常
产生订单意图。改动这一行等于改动客户能不能离场。

### 覆盖变化

`tests/domain-runtime-cycle-planning.test.mjs`(12)、`tests/domain-runtime-risk.test.mjs`(17)，
共 29 项，全部不需要数据库。此前这些判定只能靠起数据库跑整轮决策间接验证。

### 验证

tsc、lint、859 项测试（+29）、三端 build、bundle 预算、6 条边界通过。
另跑本地 Postgres 的 `official-platform-spot-runtime` /
`strategy-runtime-repository` / `beta-legacy-runtime-hardclose` 共 27 项确认
端到端未变。

### P1 收尾状态

`packages/domain/src` 约 3,500 行。仍留在 `lib/` 的运行时件是编排与仓储，
本就该在那里。P1 可以收尾，下一批进 P2（按 audience 拆 API 面）。


## 28. 2026-08-22 P2 按 audience 物理拆分 API 面

此前三个构建各自包含全部 182 个 API 路由——公网盒子上编译着运维控制面的代码，
边界只有运行时的 fail-closed 校验和 Nginx 白名单。现在最外层是「代码不存在」。

### 机制

Next 的 `pageExtensions` 决定哪些文件被当作可路由文件。文档只讲了 MDX 场景，
没说 App Router 的 `route.*` 是否也走这条解析，**所以先做了探针验证**：
建两个探针路由（一个 `route.ts`、一个 `route.operations.ts`），分别构建 client 与
operations，检查 `app-path-routes-manifest.json`。结果 client 只有共享探针、
operations 两个都有——机制成立。

（探针第一版目录名叫 `__p2probe__`，结果两个都没出现：**Next 把下划线开头的
目录当私有目录，整个排除出路由**。这不是机制不работ，是探针写错了。）

### 命名与归属

| 文件名 | 归属 | 数量 |
| --- | --- | --- |
| `route.client.ts` | 客户端 | 74 |
| `route.operations.ts` | 运营端 | 52 |
| `route.maintenance.ts` | 运维端 | 33 |
| `route.internal.ts` | 运营 + 运维 | 10 |
| `route.shared.ts` | 三端 | 13 |

归属不是猜的：从 `lib/api-route-inventory.ts` 已有的 `audiences` 字段推导出重命名
映射，182 个文件一次 `git mv`。清单本身由 `scripts/generate-api-route-inventory.mjs`
按 URL 前缀规则生成，兜底是 `throw`（未登记路由在生成期就失败），所以这份数据可信。

### 结果

| 构建 | 拆分前 | 拆分后 | 越界 |
| --- | --- | --- | --- |
| client | 182 | **87** | 0 |
| operations | 182 | 75 | 0 |
| maintenance | 182 | 56 | 0 |

52 个运营路由 + 33 个运维路由从公网构建里**物理消失**。

### 机器强制（第 7 条边界规则）

「API 路由后缀与 audience 一致」：后缀决定进哪个构建，清单决定运行时放行谁。
两者错开会产生「构建里有但运行时拒绝」（浪费）或「运行时允许但构建里没有」
（404 查半天）。裸 `route.ts` 也是违例——新路由必须显式声明归属。
配两条「故意制造违例能被抓到」的测试。

### 连带改动

- `scripts/generate-api-route-inventory.mjs`：文件识别与路由推导改用 `ROUTE_FILE` 正则。
  nginx 生成器读的是清单不是磁盘，无需改动，生成结果逐字节相同。
- 53 个测试文件里硬编码的 `route.ts` 路径按重命名映射批量更新（断言内容未变）。
- `tests/commercial-release-contract.test.mjs` 的「已废弃路由不得存在」断言原本只查
  裸 `route.ts`——重命名后全仓库已无裸 `route.ts`，那条断言会白过。改成逐后缀检查。
- `tests/api-policy-security.test.mjs` 的路由扫描过滤器同步更新。

### 一个踩到的坑（已记进 CLAUDE.md）

`next dev` 与 `next build` 共用 `.next-<audience>`。本地开着 `start-local.sh`
时跑 `npm run test:apps`，构建会随机失败，错误信息和真正的编译错误长得一样。
跑三端构建前先 `start-local.sh stop`。

### 验证

tsc、lint、861 项测试（+2）、三端 build、bundle 预算、7 条边界通过。
三端路由数经 `app-path-routes-manifest.json` 实测确认，跨 audience 越界 0 条。


## 29. 2026-08-22 P3 勘察：结论是先做 P4

P3（拆成三个独立 Next 应用）的勘察结果不支持现在就做。三条证据：

### 1. 声称的收益基本不存在

三端构建实测：编译 2.2–2.4 秒，TypeScript 检查 1.2–5.4 秒（Turbopack）。
「拆开构建更快」在这个体量上省不出东西。部署独立性是真的，但三端本来就从同一个
仓库部署到同一台自托管机器，收益有限。**安全收益已经在 P2 拿到了**——
别的 audience 的代码物理上不在构建里。

### 2. P3 的真正阻塞是 `app/` 根目录，而它大部分是待拆的东西

`app/` 根目录 34 个散件、6,772 行，完全没有按 audience 组织。构成：

| 部分 | 行数 | 说明 |
| --- | --- | --- |
| 遗留 SPA 簇 | ~3,738 | `client-app.tsx` 及其动态导入链，只服务 `/workspace`，是 P4 的目标 |
| 死代码 | ~2,580 | 零运行时引用 |
| 路由约定文件 + 共享件 | ~450 | `layout/page/error/loading/not-found`、`riverton-route*` |

现在拆三个应用，等于把死代码和待退役的遗留 SPA 分别搬进三个新应用，然后 P4 再删。

### 3. 已删除的部分（本次提交）

零引用、零测试、零文档提及的 7 个文件，836 行：

- `connect-live.tsx`(298) → `exchange-logo.tsx`(44)
- `market-news-settings.tsx`(84) → `agent-role-admin.tsx`(237)、`llm-config.tsx`(11)
- `chatgpt-auth.ts`(90)
- `simulated-order-form.tsx`(72)

删除集是闭包的：集合外没有任何模块导入它们。

### 4. 剩下的死代码需要决策，未动

另一簇 1,744 行运行时不可达，但**被 4 个契约测试 `readFile` 断言**：

| 文件 | 行数 | 守它的测试 |
| --- | --- | --- |
| `community-strategy-center.tsx` | 491 | `ai-ui-contract`、`strategy-backtest-ui`、`client-byok-hardclose` |
| `multi-agent-research.tsx` | 434 | `ai-ui-contract` |
| `strategy-backtest-detail.tsx` | 302 | `strategy-backtest-ui`、`strategy-version-rollback` |
| `strategy-backtest-center.tsx` | 283 | `strategy-backtest-ui` |
| `strategy-detail.tsx` | 234 | 仅被 `community-strategy-center` 引用 |

这些测试断言的是真实产品约束（例如 BYOK 密钥不得泄漏到 UI）。组件不可达意味着
断言当前是空转的，但删组件就要一并删断言——**等于拆掉一条绊线**。
如果这些界面还打算恢复，绊线应当保留；如果确定不恢复，组件和断言应当一起删。
这是产品决策，留给决策人。

### 建议顺序

**P4 先于 P3。** P4 退役遗留 SPA（`client-app.tsx`、`globals.css`、`globals-beta.css`、
`LocaleGuard`）之后，`app/` 根目录基本只剩路由约定文件，那时 P3 才是机械操作——
甚至可能不再必要。


## 30. 2026-08-22 P4 第 1 步：行情页迁成真实路由 `/market`

### 决策记录

P4 的阻塞不是技术，是产品决策：`/workspace` 里有四个界面没有新等价物。
已确认**四个全部保留**，迁成真实路由；「Agent 对话」改名为「AI 助手」。

| 界面 | 目标路由 | 状态 |
| --- | --- | --- |
| 行情页 LiveMarket | `/market` | ✅ 本步完成 |
| AI 助手（原 Agent 对话） | 待定 | 未开始 |
| 七智能体大厅可视化 | 待定 | 未开始 |
| AI 决策会议室 | 待定 | 未开始 |

### 本步改动

`app/live-market.tsx`(263) 与 `app/coin-icon.tsx`(32) 迁到 `apps/client/ui/`，
`market` 加入客户端路由白名单，门户新增「行情」导航项（`chart` 图标）。

**顺带修掉一个真实缺陷**：落地页的「行情」链接原本指向 `/workspace?page=market`，
而 `/workspace` 要求登录 + `client.paper.view`——匿名访客点进去被踢到登录页。
现在指向 `/market`，`ClientChrome` 会带 `?next=/market` 跳登录，登录后落在行情页。

### 一个值得记住的发现

同一个文件在 `app/` 下 lint 干净，搬到 `apps/` 下就报
`@next/next/no-img-element`——Next 的 lint 插件对 `app/` 目录有特殊处理。
**把文件搬出 `app/` 会暴露此前被静默的规则。** 剩下三步还要搬更多文件，
预期会再遇到。

`coin-icon.tsx` 这条是本地静态 SVG + `onError` 降级，`next/image` 帮不上忙，
加了带原因的 `eslint-disable-next-line`。

### 遗留世界现状

`/workspace` 及其依赖仍是 11,275 行，被 33 处契约测试断言守着。其中
`app/globals.css`（3,871 行）**没有任何页面加载它**，却有 6 个测试文件在断言它——
这些断言抓不住任何回归。删代码必须连测试一起删，所以要等四个界面全部迁完。

（本轮曾尝试直接删 `app/globals.css`，7 个测试立刻失败，已还原。）

### 验证

tsc、lint、861 项测试、三端 build、bundle 预算、7 条边界通过。
运行时实测：`/market` 在客户端 200，在运营端 404（只在客户端白名单里）。


## 31. 2026-08-22 P4 第 2 步：AI 助手（原 Agent 对话）

### 需求与现状差距

助手的用途被明确为四类：**专业行情分析、决策分析、网站信息、平台介绍**。
对照现状：

| 用途 | 迁移前 | 处理 |
| --- | --- | --- |
| 行情分析 | ✅ 有行情快照 + EMA/RSI/ATR/支撑阻力 | 保留 |
| 决策分析 | ⚠️ 只有持仓风险与回测解读，**看不到七智能体决策轮** | 新增决策轮上下文 |
| 网站信息 | ❌ 无 | 新增平台事实快照 |
| 平台介绍 | ❌ 无 | 同上 |

原提示词一半篇幅是策略 DSL 生成合同——那不在这四类里，但它是既有且被
`tests/ai-chat-strategy-save.test.mjs` 断言的功能，**予以保留**，作为第五类能力。

### 平台事实快照

新增 `packages/contracts/src/platform-facts.ts`。会员价格、时长、AI 积分、
绩效分成费率、策略卡风控参数、七阶段流程全部从既有合同常量派生，
**文件里不出现任何第二份数字**——`tests/ai-platform-facts.test.mjs` 逐个价格
断言它们没有被写死。改价时助手会跟着改，不会报旧价。

政策条款（非托管、平台永不持有提现权限、高水位线、风控不可被模型覆盖、
Beta 只跑 paper）在代码里没有常量表示，是根 CLAUDE.md 的不变量。
这里是它们唯一的面向客户措辞，同样有断言钉住。

**回答方式已确认为「全部走 LLM」**：事实作为服务端快照注入，由模型自然语言作答。
提示词里加了硬约束：平台事实只能逐项引用快照，快照没有的数字一律回答
「以平台页面为准」，绝不推测、换算或凑出新数字。

### 决策轮上下文

`lib/ai-context.ts` 新增 `decisionContext`：取该客户每张策略卡最新一轮的
动作、风控结论、拒绝理由与七阶段结论。刻意做成轻量查询——它进的是提示词，
不是页面；完整视图仍在 `/api/trading-hall`。

提示词约束：解释决策轮只能引用摘要里的结论与拒绝理由，不得替风控重新判断，
也不得暗示风控结论可以被模型覆盖（INV-1）。

### 意图分类的顺序陷阱

新增 `platform_info` 与 `decision_analysis`，**必须排在旧意图前面**：

- 「策略卡收费吗」含「策略」，排在 `strategy_research` 之后会被抢走；
- 「这一轮为什么没开仓」含「仓」，排在 `portfolio_risk` 之后会被抢走。

两条都有断言钉住。按意图决定是否装载快照——平台快照约 2KB，每次都塞进
提示词是浪费。

### UI 迁移

`app/agent-chat.tsx`(349)、`app/ai-message-content.tsx`(153)、`app/ai-sse.ts`(48)
迁到 `apps/client/ui/`，组件改名 `AiAssistantChat`，新增真实路由 `/assistant`
与导航项「AI 助手」。页面标题从「与 Agent 团队对话」改为「AI 助手」。

### 顺带清掉一份重复常量

`lib/ai-context.ts` 里的 `platformStrategyNames` 是策略卡名称的第二份拷贝，
违反 CLAUDE.md 的「领域参数唯一真源」。改为从 `packages/contracts` 查。

### 验证

tsc、lint、873 项测试（+12）、三端 build、bundle 预算、7 条边界通过。
运行时实测：`/assistant` 与 `/market` 在客户端 200、运营端 404。

### P4 剩余

七智能体大厅可视化与 AI 决策会议室仍嵌在 `app/client-app.tsx`(2506) 内部，
两者共享 `useTradingHallData`，要一起迁。迁完才能删遗留世界剩余部分
及其契约测试断言。


## 32. 2026-08-22 P4 第 3 步：交易大厅与决策会议室迁成真实路由

### 迁移

从 `app/client-app.tsx` 抽出约 390 行到 `apps/client/ui/decision-hall.tsx`：
`useTradingHallData`、`PageHead`、`AgentDialoguePanel`、`StrategyMonitorTicker`、
`hallAgentPositions`/`agents`、`Hall` → `DecisionHall`、`Meeting` → `DecisionMeeting`。
`app/trading-hall-status.ts` 一并迁到 `apps/client/ui/`。

导航从内部字符串路由 `go("...")` 换成真实跳转。

### 顺带修掉一处导航缺陷

此前 `/trading-hall`（标签「交易大厅」）与 `/paper`（标签「模拟组合」）**渲染同一个
组件** `TradingExperience`——导航上两个不同标签指向内容完全相同的页面。

现在：

| 路由 | 标签 | 内容 |
| --- | --- | --- |
| `/trading-hall` | 交易大厅 | 七智能体大厅可视化 |
| `/trading-hall/meeting` | （大厅内跳转） | AI 决策会议室 |
| `/paper` | 模拟组合 | 组合、成交明细、Demo 摘要 |

`TradingExperience` 的全部内容仍可从 `/paper` 到达，没有功能丢失。
这是产品可见变更，不是纯搬迁。

### 一处刻意的行为收窄

大厅里点击某个智能体角色，原来会把该角色名带进 Agent 对话。新的 AI 助手不按
角色分线，所以只做跳转到 `/assistant`。角色的最新结论就显示在被点击的卡片上，
不必再带过去。

### 验证

tsc、lint、873 项测试、三端 build、bundle 预算、7 条边界通过。
运行时实测：`/trading-hall`、`/trading-hall/meeting`、`/paper` 在客户端 200，
在运营端全部 404。

### P4 剩余

四个界面已全部迁完（`/market`、`/assistant`、`/trading-hall`、
`/trading-hall/meeting`）。剩下的是拆除：`app/client-app.tsx` 里 `Hall`/`Meeting`
的原始副本、`Security`（`/account/security` 已有新实现）、以及 `/workspace` 路由
本身与 `LocaleGuard`、`globals.css`、`globals-beta.css`。

拆除必须连同守着它们的契约测试断言一起做——详见 §29 与 §31 的说明。


## 33. 2026-08-22 P4 第 4 步：把研发流水线接回来（`/studio`）

### 为什么这是最高优先级

平台里有**两条**策略生成路径：

| 路径 | 保障 | 入口 |
| --- | --- | --- |
| 对话生成（AI 助手内） | 一次性 LLM 输出 + 静态校验，**无修复循环**，无回测门禁 | 有 |
| 研发流水线 | 检查点式可续跑、训练/验证集切分、回测预算、成本乘数敏感性、确定性准入（`EXPLORATION_ONLY`/`STANDARD_FAILED`/`STANDARD_VERIFIED`）、候选排名 | **断的** |

`lib/strategy-research-orchestrator.ts`(703) + 7 个 API 路由 + 专用 worker 一直都在，
唯一的前端 `app/multi-agent-research.tsx` 运行时不可达（即 §29 里那簇「死代码」）。
**它不该删，该接回来。**

### 迁移

`app/multi-agent-research.tsx` → `apps/client/ui/strategy-studio.tsx`，
新增真实路由 `/studio`，导航「策略实验室」从 `/workspace` 改指向它。

组件原本需要外部传 `brief`（问卷），问卷表单在 `app/community-strategy-center.tsx`
里。现在 studio 自带一个紧凑问卷（策略名称、风格、风险偏好、候选指标），
`brief` 降级为可选初始值。流水线的启动端点不做 brief 字段白名单校验，
其余项由智能体在研发过程中确定。

### 样式必须重写，不能照搬

原界面的样式**只存在于 `app/globals.css`**——而那份样式表没有任何页面加载。
照搬会得到一个没有样式的页面，且它满是硬编码色值，会直接违反「样式层零硬编码
色值」边界规则。新建 `strategy-studio.module.css`，23 个类名全部按 `--rv-*` 令牌重写。

### 契约测试：绊线移到活代码，并且立刻抓到一个疏漏

BYOK 硬关闭的断言（客户可达界面不得出现自定义模型配置或 API Key 输入）原本
指向 `app/community-strategy-center.tsx`——一个不可达页面，等于空转。现在指向
`apps/client/ui/strategy-studio.tsx`，**保护的是活代码**。

移过去之后立刻红了两次，两次都是真问题：

1. 新 studio 缺少「平台模型」披露——客户看不到自己用的是平台模型服务。已补。
2. 补的披露文案写成「不接受自定义大模型配置或 API Key」，**为了否认而提到了
   被禁的概念，触发了纯文本匹配的绊线**。改写为「不支持客户自备模型或密钥」。

### 未做的决定

`app/community-strategy-center.tsx`(491) 与 `app/strategy-detail.tsx`(234) 仍是
运行时不可达的死代码，只是保持可编译（import 指向新 studio）。删除它们要连带
删掉 `tests/strategy-backtest-ui.test.mjs` 里若干只描述旧表单的断言
（`查看策略`/`快速回测`/`分享到策略广场`/`studio-factor-library`）——**那是拆绊线，
留给决策人**。

### 模拟组合不移除

评估结论：`/paper` 不是低价值功能，**它是绩效分成的计费依据**。
计费基数是 `official_paper_portfolios` + `official_paper_fill_receipts`
（`lib/official-paper-repository.ts` 的周聚合）。移除它等于移除 Beta 阶段的收入
模型；只移除页面而保留记账，则变成「按客户看不到的结果收费」。

### 验证

tsc、lint、873 项测试、三端 build、bundle 预算、7 条边界通过。
运行时实测：`/studio` 在客户端 200、运营端 404。

### 策略生成的后续建议（未实施）

1. **DSL 修复循环**：对话路径校验失败时把 `StrategyDslValidationError.issues`
   回喂给模型再生成（上限 2 次），是「稳定生成」最直接的杠杆。
2. **保存时冒烟回测**：现在保存草稿只做静态转换，不跑任何回测。
   「能正常运行」的定义应是「放进运行时不炸」，建议跑短窗口回测，
   只断言能跑完 + 至少 N 笔信号，不看收益；不达标标 `NOT_QUALIFIED`（INV-6）。
3. **随机化测试**：`strategy-dsl.ts`(949) + `backtest-engine.ts`(662) 都在域层、
   纯函数、零 I/O，是属性测试的理想条件，但目前只有 10 个举例式测试、零随机化。


## 34. 2026-08-22 策略生成的三条稳定性改进

目标是「稳定的策略生成，不要求有收益，但必须能够正常运行」。

### 1. DSL 修复循环

对话路径此前是：模型一次性吐 DSL → 保存时校验 → 不合格返回 422 → 客户自己重问。
现在生成阶段就校验，不合格把具体 issue 回喂给模型重来一次。

**校验用的是 `strategyDraftFromAiMessage`——保存时的同一道闸门。** 用别的校验会
「修复」出一个仍然存不进去的东西。

`STRATEGY_REPAIR_ATTEMPTS = 1`（不含首次）。定为 1 是权衡：把校验错误明确回喂的
那一次修正拿走了绝大部分收益，而每多一次尝试就要多预留一份 Credits——预留是临时
冻结、未用部分退回，但余额紧张的客户会因冻结额度变大被判「余额不足」。

**与 Credits 系统的耦合必须一起改。** 预留原本只覆盖一次调用
（`estimatedClientAiCredits(900)`）；多调一次而不加预留，结算会因实耗超过预留被拒
（`AI_CREDIT_RESERVATION_EXCEEDED`，见 §25）。现在策略研究意图按
`1 + STRATEGY_REPAIR_ATTEMPTS` 倍预留，多次调用的用量合并上报（`usageId` 用 `+` 连接
以保留可追溯性）——否则会按单次记账，少扣客户的钱。

### 2. 保存时冒烟回测

此前保存草稿只做静态转换，**不跑任何回测**。静态校验挡不住两类问题：

- 指标周期比可用 K 线还长——DSL 完全合法，跑起来永远算不出指标；
- 条件树永远不成立——DSL 完全合法，跑完一整段历史一笔都不开。

两者都会让保存看起来成功，等客户部署之后才发现什么都没发生。

判定规则在 `packages/domain/src/strategy-smoke-test.ts`（纯函数，可脱网单测），
编排在 `lib/backtest-engine.ts` 的 `runStrategySmokeTest`。三种结局分得很清楚：

| 结局 | 含义 | 保存端点的处理 |
| --- | --- | --- |
| `passed` | 跑完且触发过信号 | 放行，结论写进保存记录 |
| `failed` | 引擎抛错、触发强平，或零信号 | **拒绝保存**（422） |
| `skipped` | 取不到行情 | 放行，但显式标注「尚未验证可运行性」 |

**不看收益。** 净值、胜率、盈亏比一概不参与判定。`skipped` 的措辞刻意不含「通过」
二字——INV-6 要求未达门槛必须显式标注，「未验证」不能在界面上看起来像「已通过」。

### 3. DSL → 回测引擎的随机化测试

`strategy-dsl.ts`(949) + `backtest-engine.ts`(662) 都在域层、纯函数、零 I/O，是属性
测试的理想条件，但此前只有 10 个举例式测试、零随机化。

`tests/strategy-dsl-property.test.mjs`：种子固定的 PRNG 生成 11 种规则的随机组合
+ 随机游走行情 + 平坦退化行情，断言引擎永不抛异常且结果结构完好
（收益/回撤/胜率是有限数、`sampleSize` 是非负整数、回撤非负）。

**结果：460+ 次随机组合没有跑出崩溃。** 引擎本身是扎实的。
写生成器时踩了一次自己的坑——取值范围靠猜，被 `normalizeStrategyDsl` 的真实边界
（`stopLossPct` 0.1–20 且必须严格小于 `maxDrawdownPct`、`positionPct` 0.1–30 等）
直接打回。范围现在照抄源码，并在注释里写明。

### 验证

tsc、lint、886 项测试（+13）、三端 build、bundle 预算、7 条边界、API inventory
`--check` 全部通过。


## 35. 2026-08-22 P4 拆除

### 删除（约 8,900 行）

`app/client-app.tsx`(2506)、`app/globals.css`(3871)、`app/community-strategy-center.tsx`(491)、
`app/strategy-detail.tsx`(234)、`app/locale-guard.tsx`(103)、`app/i18n-runtime.ts`(180)、
`app/account-settings.tsx`、`app/support-floating.tsx`、`market-terminal.css`(311)、
`membership-center.css`、`/workspace` 路由及其外壳三件。

### 拆除过程中发现的回归（P4 第 2、3 步引入，本次修复）

**`/assistant` 与 `/trading-hall` 迁移后一直是没有样式的。** 第 2、3 步只搬了组件
没搬样式：`agent-chat-*` / `hall-*` / `meeting-*` 类名只在 `globals.css` 与
`globals-beta.css` 里有定义，而门户根 `client-portal-root.tsx` 只加载
`riverton-console.css`。

当时的验证只做到 HTTP 200，没验证渲染。**实测确认**：`/assistant` 加载的两个样式表
共 36KB，`agent-chat` 规则 0 条。

临时修复是让门户根 import `globals-beta.css`（36KB → 276KB）。这不是终态：
正确做法是把那约 515 条规则转成令牌驱动的 CSS Module，和
`strategy-studio.module.css` 一致。已登记进 CLAUDE.md 遗留表，并在遗留围栏规则里
显式列出这个引用点——**不让规则静默变宽**。

教训：迁移 UI 时「路由通了」不等于「页面对了」。验证要落到渲染产物上。

### 契约测试：33 处断言的去留

逐条判定，不整体删除：

**迁到活代码（绊线继续有效）**
- BYOK 硬关闭 → `ai-assistant-chat.tsx` + `strategy-studio.tsx`
- 会话与权限强制 → `client-chrome.tsx` + `client-portal.tsx`（含四个迁移界面各自的权限判定）
- 七角色契约、大厅不得展示静态行情 → `decision-hall.tsx`
- 品牌资产、客服渠道 → `client-portal-shell.tsx` + `support-workspace.tsx`
- 核心工作区存在性 → `client-portal.tsx` 的逐路由分发
- `globals.css` 的样式断言 → `globals-beta.css`（规则大多两边都有）

**删除（只描述已删代码，且有更强的替代机制）**
- 「客户端不再暴露遗留运营页面」——现在由 P2 的构建隔离从结构上保证：运营路由
  根本不在 client 构建里（第 7 条边界规则 + §28 的 404 矩阵）。文本断言被更强的
  机制取代。
- 「隔离工作区打开实时记录」——断言的是 SPA 内部字符串路由，已不存在。
- `.risk-check-grid`——只存在于已删的 `globals.css`，无任何页面引用。

### 未拆：回测界面

`strategy-backtest-center`(283) 与 `strategy-backtest-detail`(302) 在本轮**恢复**了。
理由：它们的后端仍在且完整（`/api/strategy-marketplace/[id]/backtest`，支持
NDJSON 流式阶段进度），删掉等于悄悄丢一个功能。

现状是它们**既没有路由也没有样式**（原样式在已删的 `globals.css` 里）。
两条路：按 `/studio` 的做法接回真实路由并按令牌重写样式，或连同后端一起退役。
已写进 CLAUDE.md 遗留表。

### 验证

tsc、lint、884 项测试、三端 build、bundle 预算、7 条边界通过。


## 36. 2026-08-22 回测界面接回真实路由 `/backtests`

### 迁移

`strategy-backtest-center`(283) 与 `strategy-backtest-detail`(302) 迁到
`apps/client/ui/`，新增包装组件 `backtest-workspace.tsx` 负责取已保存策略列表
（`GET /api/strategy-marketplace` 的 `mine`）并按路由段分发：
列表 `/backtests`，单策略 `/backtests/:id`。导航新增「策略回测」。

与 `/studio` 的分工写进了组件注释：**studio 产生策略**（多智能体研发流水线，
自带训练/验证集切分与确定性准入），**backtests 对已保存策略按自选参数复算**，
用于解读与对比。

### 样式按令牌重写

原样式只在已删的 `globals.css` 里。新建 `backtest.module.css`，33 个类名全部按
`--rv-*` 令牌重写。其中运行状态条改用 `data-stage` 属性表达阶段，而不是把状态
编进类名——后者会让「新增一个阶段」变成必须同步改样式表。

### 验证方法的修正

上一批的教训（§35）是「路由通了不等于页面对了」。这次专门验证了样式：

- 初次检查用「初始 HTML 里的 CSS 链接是否含回测规则」，结果为否——但那是
  **检查方法错了**：组件走 `next/dynamic`，CSS 随组件 chunk 按需加载，本来就
  不在初始 HTML 里。
- 改为检查构建产物：dev 与生产构建里都存在含 `equityChart` / `controlDeck`
  规则的 CSS chunk，与组件绑定。

与 §35 那次回归的本质区别：那次是**类名引用的样式表没有任何页面加载**；
这次是 CSS Module 由组件自己 import，必然随组件一起送达。

### 验证

tsc、lint、884 项测试、三端 build、bundle 预算、7 条边界通过。
运行时实测 `/backtests` 与 `/backtests/:id` 在客户端 200、运营端 404。


## 37. 2026-08-22 门户样式全部转成令牌驱动的 CSS Module

§35 的临时债还清：`app/audience/client-portal-root.tsx` 不再 import
`globals-beta.css`，遗留围栏规则恢复为「只允许落地页引用」。

### 新增七个 CSS Module

| 模块 | 覆盖 |
| --- | --- |
| `ai-assistant-chat.module.css` | AI 助手对话（原 111 条规则，大半是 beta 覆盖链） |
| `decision-hall.module.css` | 交易大厅与决策会议室 |
| `live-market.module.css` | 行情终端（品种搜索、K 线、成交量、十字光标、资讯） |
| `backtest.module.css` | 回测中心与单策略配置回测 |
| `strategy-studio.module.css` | 策略实验室（更早一批） |
| `ai-message-content.module.css` | 助手回复富文本与待确认问题对话框 |
| `client-notification-settings.module.css` | 通知偏好 |

全部按 `--rv-*` 令牌重写，不是逐条搬运遗留规则——那些规则里大半是 beta 改版
叠加在旧设计上的 `!important` 覆盖链。

### 拆除批次的第二个样式回归

`/market` 的约 45 个类名在 `riverton-console.css` 与 `globals-beta.css` 里**都没有**：
它们原在 `app/market-terminal.css`，而那个文件在 §35 被删（当时它唯一的引用点是
已退役的 `client-workspace-root`）。恢复出来一看，`market-terminal.css` 只有 311 行
字号微调，**真正的终端样式在同批删掉的 `globals.css` 里**——所以 `/market` 的样式
是从零重写的。

这是同一个教训的第二次：删样式表前要查的不是「谁 import 了它」，而是
**「谁在用它的类名」**。

### 定位数据不进样式表

K 线的 top/height、成交量柱高、画布宽度、智能体的 x/y 百分比都由组件用行内
`style` 给出——那些是价格与坐标换算的**数据**，不是样式。模块只提供定位机制
（`position` / `transform` / grid）与配色。同理，序号与状态改用 `data-*` 属性
（`data-seat`、`data-inactive`、`data-streaming`、`data-stage`），不编进类名，
否则「多一个角色/状态/阶段」就得改样式表。

### 顺带修掉的可访问性与合规细节

- 原生 `<dialog>` 用 `showModal()` 打开必须显式居中，否则贴在视口顶部。
- 生成中的点动画与流式光标都加了 `prefers-reduced-motion` 降级。
- 降级资讯卡片带「非实时」标记，不能和实时内容长得一样（INV-6）。

### 验证

tsc、lint、884 项测试、三端 build、bundle 预算、7 条边界通过。
构建产物实测：七个模块的 CSS chunk 全部存在且含各自的规则。


## 38. 2026-08-22 删除 `globals-beta.css`，落地页样式收敛到自己的文件

### 令牌化没做——原因写清楚

原计划是把落地页也令牌化然后删掉 `globals-beta.css`。**令牌化那一半做不了**：

落地页仍在使用的 477 条规则里有 **293 种不同色值，其中 244 种只出现一次**。
这是三代设计层层叠加的产物（同一个变量 `--green` 被 `!important` 重定义多次，
最终值是 `#3478d4`——一个蓝色，名字是上一版设计的遗留）。

把 293 种颜色映射到一套真实令牌，页面观感必然变化。**那是品牌决策，不是重构。**
所以本次只做能做的那一半。

### 做了的部分：删死规则 + 收敛作用域

`app/globals-beta.css` 1,676 条规则里：

| | 规则数 | 占比 |
| --- | --- | --- |
| 落地页仍在用 | 477 | 28% |
| 已无人引用（服务 P4 退役的界面） | 1,199 | **71%** |

抽出仍在用的部分到 `apps/client/ui/client-public-landing.css`（1,249 行），
删除 `app/globals-beta.css`(1922) 与 `app/agent-role-admin.css`（后者的组件已在
P4 删除，落地页不引用它的类名）。

类名保持不变，因此 TSX 零改动，**视觉零风险**。

### 视觉验证方式

不靠肉眼看截图：改动前后各跑一次 `getComputedStyle`，比对 body、`.panel`、
`.role-grid article`、`.topbar`、`.primary` 的 color / background / border。
**五项逐项一致。**

改动前的基线是在浏览器里读的实际渲染值，不是从 CSS 源码逆推层叠——那份文件
同一个变量被重定义多次，逆推不可靠。

### 遗留围栏

规则条目从 `globals-beta.css` 改为 `client-public-landing.css`，仍只允许
`client-landing-root.tsx` 引用。新文件**不加入**「样式层零硬编码色值」的受检
清单——这是刻意的例外，已在 CLAUDE.md 遗留表里写明理由。

### 剩下的决定

落地页令牌化 = 定一套真实调色板并按它重新配色。收益是可维护、可主题化；
代价是公开营销页的观感会变。要做的话应当当作一次设计改版来做，不是重构。

### 验证

tsc、lint、884 项测试、三端 build、bundle 预算、7 条边界通过。
落地页 HTTP 200，计算样式与改动前逐项一致。


## 39. 2026-08-22 落地页重设计

### 为什么重设计而不是只令牌化

§38 的结论是「落地页 293 种色值、244 种只出现一次，机械令牌化会改变观感」。
决策是**当作设计改版来做**。重设计顺带解决了三个实质缺陷：

**1. 七个角色里有三个是 CSS 注入的。** `TECHNICAL` / `EXECUTION` / `CRITIC` 用
`content:` 写在样式表里，靠 `html[lang^="zh"]` 做「翻译」——于是 7 种语言里有
**5 种（俄/西/日/韩/繁中）只显示英文**，而且 CSS 文本对读屏不可靠。
现在七个角色全部来自与下方角色栅格同一份本地化数据，7 种语言都对（已实测日语）。

**2. 首屏没说清产品是什么。** 旧版把决策链画成一圈装饰性轨道，标签互相重叠
（「市场状态」压着轨道环、「风险设置」压着「MARKET」框），只显示 4 个角色却标着
「7-STAGE DECISION CHAIN」。新版把它做成页面的论点：七阶段竖排链路，
**第 5 阶段（首席风控官）单独标成琥珀色闸门**并附一句说明——
「确定性代码可以否决前面全部 AI 结论」正是这个平台的卖点，旧版完全没表达。

**3. 右上角「用户」按钮删除。** 它调用的是 `navigate("login")`——和旁边的「登录」
完全相同的动作；标签 `用户` 是写死的中文，在 7 语言页面里不翻译。重复 + i18n
缺陷。（有趣的是旧样式表里本来就有一条 `.top-user-guest{display:none!important}`，
只是在落地页上没生效。）

### 设计

单一深色视觉世界，不跟随 `prefers-color-scheme`——落地页与门户是两种场景。
调色板写在模块顶部，全部 oklch。

**强调色用琥珀**，且它在这里有语义：决策路径、批准、凭证、审计留痕。
行情数据另用冷色，两者不混。这也避开了「近黑底 + 蓝紫渐变」的通用 AI SaaS 模板。

排版用已加载的 Geist + Geist Mono（**不新增字体**）：等宽用于序号、角色代码、
数据标签，给页面一种仪表盘的语气，也把中英文分开。

**动画只保留一个**，且它在说明一件真事：信号沿决策链逐阶段推进，到风控闸门停下。
带 `prefers-reduced-motion` 降级。旧版的轨道旋转是纯装饰。

### 结果

- `client-public-landing.module.css`（约 400 行）取代 1,249 行的抽取版
- 客户端 JS **202,530 / 204,800**，余量从约 160 字节涨到 **2,270 字节**
  （删掉轨道图那堆 DOM 的收益）
- 客户端 CSS 15,875 / 51,200

### 踩到的两个坑

**`initialLocaleData` 是 zh-CN 的第二份真源。** 新增的 `gateNote` 加进语言文件后
中文仍是空的——因为首屏为了不加载整个语言包，把 zh-CN 内联在组件里。已在
CLAUDE.md 写明。

**`next/image` 的 `sizes` 不约束渲染尺寸。** 页脚 logo 没写 CSS 宽度，按内在尺寸
（2193px）铺满整行。`sizes` 只影响下载哪张图。

### 验证

tsc、lint、884 项测试、三端 build、bundle 预算、7 条边界通过。
1440 与 375 两个宽度实测无横向溢出；日语下七角色与闸门说明均正确渲染。


## 40. 2026-08-22 落地页间距与重复内容

反馈是「卡片之间间距有点大」。实测下来卡片间距本身是 12px（已经很紧），
看起来空的是另外两处：

### 1. 分区之间约 200px

`--step` 是 `clamp(3.5rem, 7vw, 6.5rem)`，而两节之间是 2×`--step`——1440px 宽下
每节上下各 100.8px。改为 `clamp(2.5rem, 4.6vw, 4rem)`，两节之间 128px。

### 2. 栅格末行留洞

`repeat(auto-fit, minmax(15rem, 1fr))` 在 1152px 下算出 4 列：7 张卡剩 1 个洞，
6 张卡剩 2 个洞。改成按内容条数固定列数（3 列，窄屏 2 列 / 1 列），空位归零。

### 3. 角色栅格与 hero 链路完全重复（§39 引入）

脚本比对确认：七个角色名相同，**七条职责文案逐字相同**。§39 把角色搬进 hero
链路之后，「AI QUANT TEAM」那一节就成了同一份内容的第二次陈述。

删除该分区，把其中值得保留的 `teamSub` 文案移到 hero 链路下方。
`RoleIcon`（50 行 SVG）只服务那个栅格，一并删除。

结果：页高 5266 → 3861，客户端 JS 202,530 → 202,008。

### 一次操作失误

删 `RoleIcon` 时按 `s.index("\n}")` 找函数结尾，匹配到了内层花括号，留下孤立的 `}`。
用 `git checkout <file>` 恢复时把该文件**全部未提交改动**一起回退了，三处编辑要重做。
按明确行边界（11–61）重做后正常。

### 验证

tsc、lint、884 项测试、三端 build、bundle 预算、7 条边界通过。
实测栅格空位 0、无横向溢出、角色名不再重复。


## 41. 2026-08-22 行情请求收敛（规模工作第一步）

### 量出来的问题

官方现货的部署粒度是 **每个 (客户, 策略卡) 一个**：`strategy_deployments` 带
`owner_user_id` + `paper_portfolio_id`，每个部署自己跑决策周期。

- 5,000 会员 × 3 张卡 = **15,000 个部署**
- 三张卡合计只有 **6 种 (品种, 周期) 组合**（BTC/ETH/SOL × 1h/15m）
- 每个周期各自 `getSpotCandles(..., 500)`，且 `public-market-source` 用
  `cache: "no-store"`

即同一份 K 线被重复拉取 2,500 次。打公开行情接口必然触发限流封禁。

**一处自我更正**：起初判断快照表会存储爆炸，查了 0004 号迁移后发现
`market_data_snapshots` 存的是 `candle_sha256` / `dataset_sha256` 等哈希，
**不存 K 线本身**，每行只有几百字节。存储不是瓶颈，请求次数才是。

### 做法

`packages/domain/src/runtime/market-cache.ts`（纯函数，可脱网单测）定义
「一份行情什么时候还能用」：**按归属的 K 线桶判定，不是固定 TTL**——
新 K 线一收盘立即失效，否则决策会落在上一根上，违反 INV-8
「决策绑定具体的已收盘 K 线」。未知周期返回 null，调用方据此放弃复用而不是
猜一个时长（INV-7）。

缓存本身在 worker 里（进程状态）。两个细节：

- **同 key 的并发请求共享同一个 Promise**——否则 15,000 个部署会同时穿透缓存。
- **失败的请求立刻从缓存移除**——留下坏条目会让它在整个 K 线周期内被反复复用。

### 未解决的部分（已写进 CLAUDE.md 已知缺口）

行情请求收敛了，但**决策轮的数量没有**：15,000 个部署仍意味着每根 K 线
15,000 次租约/心跳/完成事务和 15,000 行决策记录，而其中只有 6 份不同的判断。

而且这与 CLAUDE.md「决策轮」术语里写的「每张策略卡一轮，扇出到所有订阅该卡的
客户组合——不是每个客户一轮」**不一致**。文档描述的是目标形态，实现是另一种。

真正的修法是让决策轮按 (卡, 品种, 周期) 产生一次再扇出。这会改动 INV-8 的
决策轮模型，需要单独规划，不适合顺手做。

### 验证

tsc、lint、892 项测试（+8）、三端 build、bundle 预算、7 条边界通过。
另跑本地 Postgres 的 `official-platform-spot-runtime` 与
`strategy-runtime-repository` 共 23 项确认端到端未变。


## 42. 2026-08-22 决策轮扇出模型的方案（ADR-0018，待确认）

§41 收敛了行情请求，但决策轮本身的数量没动。写成
`docs/adr/0018-shared-decision-rounds-and-per-portfolio-admission.md`，状态 Proposed。

### 摸清的依赖

`cycle_id` 的下游共四处：`strategy_runtime_events`（每轮 7 行）、
`strategy_runtime_explanation_jobs`（每轮最多 2 个，每个是一次真实 LLM 调用）、
`official_paper_order_intents`、平台 Demo 意图。

**最贵的是解释任务**：它按 `cycle_id` 建，触发条件是「动作不是 hold，或风控拒绝」。
一旦某张卡产生信号，15,000 个周期各自发起解释——同一段解释被生成上万次。
这不是性能问题，是直接的 AI 成本问题。

### 方案要点

把「决策」与「准入」分开：

- **共享**：行情、技术信号、策略方案、反方审查、卡级风控阈值、最终叙述、LLM 解释。
  身份是 (strategy_code, symbol, timeframe, candle_close_time)。
- **按组合**：权益/回撤/熔断/访问状态、持仓、下单量换算、回执、账本。

阶段 5 有两半：卡级阈值共享，组合级准入逐个执行。

**域层不需要改**——这正好落在 P1 建好的执行缝上：`OrderIntent` 带的是
`targetPositionRatio` 而非绝对数量，`resolveOrderQuantity` 在扇出时按各组合的
资金与上限换算。

### 两个需要产品决定的点

1. 客户视图措辞：七阶段内容对同卡客户完全相同，是否明说「本卡的公共决策轮」。
2. 纯 hold 是否为每个组合留痕：不留则每天省下百万行级写入与分区维护，
   留则合规上「每客户每 K 线一条记录」成立。

### 一处顺带确认

`strategy_runtime_cycles` **不在**审计哈希链里（0044 只覆盖 `audit_logs` 与 8 张
`*_decisions` 表），所以这次改动不触碰防篡改边界。绩效结算依据是
`official_paper_fill_receipts`，也不依赖 cycle 结构。


## 43. 2026-08-22 解释任务按决策轮共享（ADR-0018 第 2 步）

迁移 0047：`strategy_runtime_explanation_jobs` 加 `decision_round_id` 与部分唯一
索引 `(decision_round_id, event_role)`；`strategy_runtime_events` 加
`(decision_round_id, role)` 索引供写回使用。

### 收益

解释内容解释的是**卡级结论**，不含任何客户数据，因此同一张卡在同一根 K 线上的
解释对所有订阅者完全相同。改为按轮建任务后，某张卡产生信号时的 LLM 调用从
「每个部署一次」变成「每轮每角色一次」——5,000 会员场景下从上万次降到最多 12 次。

### 两个实现细节

- **`ON CONFLICT` 不指定目标。** 这里有两条唯一约束同时起作用：
  `UNIQUE (cycle_id, event_role)` 挡同一周期重复入队，部分唯一索引挡同一轮下
  **不同部署**重复入队——后者才是省钱的那条。指定单一目标会让另一条抛唯一冲突。
- **`pending` 状态也按轮设置。** 否则只有第一个入队的部署显示「解释生成中」，
  其余客户在解释返回前看到空白。

### 写测试时踩到的两个坑

1. **不能假设租约顺序。** `leaseNextRuntimeExplanationJob` 是全局取下一个 pending
   任务，同一个 schema 里更早的测试会留下任务。改成排干队列再断言结果。
2. **`explanation_status = 'not_requested'` 是正常默认值，不是缺失。**
   断言范围要限定在真正建了任务的角色上，否则 `decision` 等角色会被误判为失败。

### 验证

tsc、lint、893 项测试、三端 build、bundle 预算、7 条边界通过。
迁移在一次性库与本地开发库各验证一次，可重复执行。


## 44. 2026-08-22 读取路径切到共享决策轮（ADR-0018，与原第 4 步对调）

### 为什么调换顺序

ADR 原排的是「先改写入、再改读取」。实施时发现这个顺序有问题：写入端一旦停止为
每个部署重复写事件，读取端若还按 `cycle_id` 查就会拿不到数据，中间存在一个数据
不可见的窗口。

反过来先切读取是安全的——事件从第 1 步起就同时挂在周期和决策轮上，读取端此刻
切过去读到的是同一份数据。ADR 的实施顺序已相应更新。

### 改动

`/api/trading-hall` 的事件查询改为优先按 `decision_round_id` 取，没有轮的行
（过渡期历史数据、永续部署）回落到 `cycle_id`。过渡期一个轮下有 N 个部署各写的
事件，按 role 去重后每轮只呈现一套。

### 措辞（按已定的产品决策）

`TradingHallDecisionRound` 新增 `sharedDecisionRoundId`，两处展示决策轮的界面都
点明这是本卡的公共轮。完整措辞：

> 这是该策略卡在这根 K 线上的公共决策轮：七阶段结论对订阅同一张卡的所有客户
> 完全相同，不含任何客户数据。**你的仓位与风控准入按你的组合单独判定。**

后半句同样必要——只说「共享」会被理解成「大家仓位一样」，那是错的：准入、
下单量、持仓、回撤都是逐客户的。措辞由契约测试钉住。

### 验证

tsc、lint、894 项测试（+1）、三端 build、bundle 预算、7 条边界通过。


## 45. 2026-08-22 写入端停止重复（ADR-0018 第 4a 步）

第 4 步分成两个可独立验证的子步。这是第一个：让写入端不再为每个部署重复写共享内容。

### 两处收敛

| | 现在 | 之后 |
| --- | --- | --- |
| 七阶段事件行 | 105,000 | **7** |
| 行情快照行 | 15,000 | **6** |

- **事件**：只有创建决策轮的那个部署写这 7 行。判断依据是 upsert 的
  `RETURNING id` 是否返回行——**让数据库决定谁是创建者**。用「先查一下有没有」
  会有竞态：两个 worker 可能同时查到空，然后都写一套。
- **快照**：`sourceId` 从周期 id 换成决策轮 id。`saveMarketDataSnapshot` 的
  `ON CONFLICT (source_type, source_id)` 本来就是幂等的，换个 key 就共享了。

安全前提是 §44 已完成：读取路径优先按 `decision_round_id` 取事件，
所以不写重复行不会让任何客户看不到结论。

### 写测试踩到的第三个坑

断言「同一决策轮只有 7 行事件」时得到 0 行。原因是**决策轮的身份是
(卡, 品种, 周期, K线收盘时间)**，而更早的测试用了同一份 K 线 fixture——
它已经创建过同一轮，去重正确生效，是测试的假设错了。给本测试单独偏移 90 天的
K 线窗口后正常。

这一条值得记住：共享单元的身份跨测试可见，fixture 复用会让测试互相影响。

### 验证

tsc、lint、894 项测试、三端 build、bundle 预算、7 条边界通过。


## 46. 2026-08-22 纯 hold 不留痕（ADR-0018 第 4b 步）

### 一个必须先解决的前提

「纯 hold 不留痕」不能单独实施。不留痕之后，客户视图若还经由自己的周期取决策轮，
**hold 那根 K 线上会看到上一次有动作时的旧轮**。所以先把读取改成直接从
`strategy_decision_rounds` 取该卡该品种的最新一轮。

这是本 ADR 里第二次遇到「写入的收敛必须由读取先就绪」——第一次是 §44。

### 判定规则（域层纯函数）

`shouldPersistAdmission`：产生意图、风控拒绝、组合级拒绝理由、非 hold 动作——
任一成立就留痕；只有「风控放行且动作是 hold」才跳过。

留痕的那些情况有个共同点：**它们是「同一轮里这个客户与别人不同」的地方**。
不留痕就没法回答「为什么我没成交而他成交了」。

### 中途发现的设计错误

最初把事件写入也绑到了「是否留痕」上。结果是纯 hold 的那一轮**没有七阶段叙述**
——恰恰把最需要解释的情况解释没了：客户想知道的正是「为什么这一轮什么都没做」。

根因是数据模型：事件要求 `cycle_id NOT NULL`，于是「没有周期就没有叙述」。
但七阶段叙述属于**共享轮**，不属于某个客户的周期。迁移 0048 让 `cycle_id` 可空，
加 `CHECK (cycle_id IS NOT NULL OR decision_round_id IS NOT NULL)`，
并用两条部分唯一索引保证一轮七阶段、每 role 一行
（原有的 `UNIQUE (cycle_id, ...)` 在 NULL 时不起作用）。

### 租约模型的重新评估

ADR 原本还要把租约单元从「部署」换成「决策目标」。4a 完成后重新算了一遍：

- 每部署剩下的工作里，**风控刷新与访问状态检查是不可共享的必要工作**，
  换租约模型也省不掉；
- 真正能省的是租约/心跳/完成三条事务与引擎评估（纯 CPU，亚毫秒），
  15,000 部署下约 45,000 条语句/根 K 线。

不是零，但需要重写运行时调度器——整个运行时里风险最高的一块。
已在 ADR 里建议单独立项。

### 验证

tsc、lint、901 项测试（+7）、三端 build、bundle 预算、7 条边界通过。
迁移 0048 在一次性库与本地开发库各验证一次，可重复执行。


## 47. 2026-08-22 共享轮的客户数据泄露（自查发现并修复，ADR-0018 第 5 步）

### 问题

做第 5 步前先核对决策轮里到底存了什么，发现一个**我自己在第 1 步引入的泄露**：

决策轮的 `decision_json` 与七阶段事件都来自 `evaluateStrategyRuntimeCycle`，
而 worker 传给它的 `riskState` 是**这个部署所属组合的真实风控状态**
（回撤、当日亏损、连续亏损、熔断/访问状态）。引擎的 risk 阶段把它原样放进
`evidence.riskState`。

第 1 步开始把事件写到共享轮，4a 又改成「只有创建者写」——于是**某一位客户的
财务状况成了该卡的公共叙述，展示给订阅同一张卡的所有其他客户**。

严重性：泄露的是可识别到具体组合的回撤百分比、当日亏损百分比、连续亏损次数与
是否熔断。虽然不含姓名，但那是真实客户的财务状态。

### 修复：阶段 5 真正拆成两半

ADR 里写的「阶段 5 有两半」被我推迟到了第 5 步，泄露正是推迟的代价。现在落地：

- **卡级**：用 `neutralRuntimeRiskState()`（新增，域层）算，产出共享决策轮的结论与
  七阶段叙述。中性状态的含义是「卡级阈值判定，尚未套用任何组合的实际状态」。
- **组合级**：用该客户真实的 `resolveRuntimeRiskState` 结果算准入，写在他自己的
  周期行上。

引擎是纯函数，跑两次的代价是亚毫秒级，换来的是共享单元里没有客户数据。

### 断言

`tests/strategy-runtime-repository.test.mjs` 直接读共享轮的 risk 事件 evidence，
断言 `riskState` 五个字段全部为中性值。带上任何客户读数都会红。
同一条规则也写进了 CLAUDE.md 的已知缺口。

### 教训

把「共享」和「逐客户」混在同一个计算结果里，泄露是必然的而不是偶然的。
拆分点应当在**产出数据的地方**（引擎调用），而不是在展示的地方过滤——
后者迟早会漏掉一个字段。

### 验证

tsc、lint、901 项测试、三端 build、bundle 预算、7 条边界通过。


## 48. 2026-08-22 修复 `test:smoke` 的过时断言

### 为什么它一直是红的

`scripts/smoke-next-render.mjs` 起一个生产 Next 服务并断言 `/` 的 HTML 含
「正在验证客户端会话」。那是 `/` 还渲染门户外壳时写的断言——ADR-0017 把 `/`
划给公开落地页之后，这条就再也不可能成立。**是断言过时，不是回归**，
所以此前一直标注为「已知失败，不要为了让它通过而改产品行为」。

### 改法：覆盖两个入口，而不是放宽

客户端有两个入口，生产构建必须两个都能服务端渲染：

| 路由 | 内容 | 断言 |
| --- | --- | --- |
| `/` | 公开落地页 | 有品牌、有主标题、有七阶段角色名；**不得含会话验证态** |
| `/dashboard` | 门户 | 有会话验证态；**不得含落地页主标题** |

两侧的「不得含」同样重要：落地页混进门户外壳会让匿名访客看到会话验证态而不是
营销页；门户回落到落地页则是路由兜底出了问题。这两种故障原来都测不出来。

主标题与角色名的断言也比只查 `<title>` 强——后者无法区分「渲染成功」与
「壳子返回了但内容没渲染」。

### 验证

`npm run test:smoke` 通过（会先跑 `build:client`，较慢）。
tsc、lint、901 项测试、7 条边界通过。


## 49. 2026-08-22 审计链尾锚定

### 缺口

0044 的哈希链能检出「改内容」与「删中间行」，但**检不出截断链尾**：把最后 N 行
删掉，剩下的链依然自洽。链内校验无法自证「本该还有多少行」。

在一次性库上把这件事演了一遍，结果是决定性的：

```
写 5 条 → 登记锚点 → 删触发器 → 删掉 chain_seq > 3 的行

verify_audit_log_chain()      → 0 个问题     ← 链依然自洽，这就是盲区
verify_audit_chain_anchors()  → chain_seq 5：锚定的审计行已不存在
```

### 做法（迁移 0049）

`audit_chain_anchors` 记录锚定时刻的链尾：`chain_seq` + `row_hash` + **总行数**。
行数是第三个独立信号——即使有人补写了一条 `chain_seq` 相同的假行，行数也对不上。

锚点自身 append-only（复用 0044 的触发器函数）：可改的锚点等于没有锚点。

运维端接口 `/api/maintenance/audit/anchors`：GET 列出并附一次校验，POST 登记当前链尾。
链尾没变时不重复登记——反复登记同一个链尾只让归档变吵，不增加保护。

### 三个状态不能合并

接口返回 `not_anchored` / `verified` / `violated`。**没有锚点时 violations 也是空数组**，
但那代表「没有保护」而不是「验证通过」。把两者都当成绿灯正是 INV-6 要禁止的那类
伪装就绪。同理，空审计表不登记零值锚点。

### 未做的部分（GA 前必须补）

**锚点导出到库外。** 锚点存在同一个库里，有完整写权限的人可以先删触发器再连锚点
一起删。真正的防线是定期外送到备份、运维端存档或外部日志系统。
本次做的是让「截断可被发现」在库内成立，外送是运维动作，已写进 CLAUDE.md。

### 验证

tsc、lint、908 项测试（+7）、三端 build、bundle 预算、7 条边界通过。
新接口只出现在 maintenance 构建里（client/operations 的 manifest 里没有）。
迁移在一次性库与本地开发库各验证一次。


## 50. 2026-08-22 P6 规划：GA 执行服务与密钥托管（ADR-0019，待确认）

写成 `docs/adr/0019-ga-execution-service-and-key-custody.md`，状态 Proposed。

### 摸底时发现的中心问题

凭证用 AES-GCM 加密后**内联存在 `exchange_accounts.encrypted_credential_ref`**
——字段名有误导性，它不是外部保管库的引用，就是密文本身。密钥来自环境变量。

**任何同时拥有该环境变量与数据库读权限的进程都能解密全部客户的交易凭证。**
而公网面向客户的 Web 进程正是这样一个进程：`exchange-accounts/[id]` 的 `check`
动作会解密去验连通性。经构建产物核实，该路由在 client 构建里（operations 与
maintenance 各 0 条）。

这与 `execution-port.ts` 注释里写的设计意图直接矛盾——那里写着「真实执行必须跑在
独立进程、独立网段，是全系统唯一能解密凭证并签名的地方」。

Beta 只跑 paper 时风险被限制在「凭证泄露但平台不下单」。GA 之后，公网盒子被攻破
一次 = 全部客户的交易权限被拿走。已写进 CLAUDE.md 的已知缺口。

### 已经就位的部分

P1 建的执行缝正好够用：`OrderIntent` 带 `targetPositionRatio` 而非绝对数量，
`resolveOrderQuantity` 在扇出时按各组合资金与上限换算。**域层不需要为 GA 改动。**
INV-11 由数据库约束强制（密钥不得有提现权限）。决策轮已共享化（ADR-0018），
扇出结构就位。

### 方案要点

1. **密钥离开 Web 层**：只存在于执行服务的进程环境。Web 层两处需要凭证的地方
   （连通性检查、紧急平仓）改为委托。由架构边界规则强制「Web 层不得 import
   解密函数」——能机器检查，不是约定。
2. **执行服务**：独立进程、只监听内网、不接受公网入站，是全系统唯一能解密并签名
   的地方。实现域层的 `ExecutionPort`。
3. **扇出四件事**：两级限流池；`clientOrderId` 由
   `(decisionRoundId, portfolioId, action)` 确定性派生做幂等；部分成交如实记录为
   `partial` 不得四舍五入成 `filled`；下单后必须查单对账，不确定状态下暂停新开仓。
4. **失败隔离**：单账户失败不影响其他；交易所不可用时暂停新开仓但不阻断平仓。

### 三个未决问题（已在 ADR 里单列）

执行服务与 Web 之间的认证方式、是否再上一层保管库、首批支持哪些交易所。

### 实施顺序

第 1 步「把密钥从 Web 层拿掉」不依赖后面任何一步，且立刻显著缩小敞口。
委托目标可以先是同进程的内部模块，把调用形状定下来，之后再抽成独立进程。


## 本地环境：Postgres 测试突然全部 SASL 报错

现象：`tests/*-postgres.test.mjs` 集体失败，报
`SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`。

原因不在代码：**另一个项目的容器占用了 `127.0.0.1:5432`**。本机 postgres 监听
`*:5432`，容器的端口转发绑在 `127.0.0.1:5432` 上并优先，于是测试连到了容器里的
另一个 postgres。

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN     # 看是谁占着
```

两条出路，任选：

```bash
docker stop <占用端口的容器>
# 或者绕开 TCP 走 unix socket
TEST_DATABASE_URL="postgresql:///postgres?host=/tmp" npm run test:all
```


## 本地环境：next-env.d.ts 会被并发重写，别把半截文件提交进去

`next dev` 与 `next build` 都会重写 `next-env.d.ts`，且内容随 audience 变化
（`.next-client/` vs `.next-maintenance/`）。在开发服务器运行时执行 `git add -A`，
有概率抓到写了一半的文件——曾经就这样提交过一个被截断的版本。

它的表现很隐蔽：`next build` 会重新生成这个文件，所以**三端构建全绿**，
只有 `tsc --noEmit` 会报 `TS1003: Identifier expected`。

两条纪律：

```bash
bash scripts/dev/start-local.sh stop   # 提交前先停开发服务器
npx tsc --noEmit; echo $?             # 直接看退出码
```

第二条尤其重要：`npx tsc --noEmit | grep ... | head` 读到的是 **grep 的退出码**，
那样的类型检查永远是绿的。

## 实盘：记账已接通，闸门收敛成一道（2026-08-23）

见 ADR-0020。要点：

**模拟盘与实盘是同一本账，只差 `book` 维度与本金。** `official_paper_portfolios`
新增 `book`（paper/live）；paper 本金恒 10000（产品规则，让客户可横向比较），
live 为客户真实投入。域层 `principalUsdt` 从字面量类型 `10_000` 放宽为 `number`。

改动这块时最容易踩的两条：

1. **记账里不许出现 `OFFICIAL_PAPER_PRINCIPAL_USDT`**，一切百分比上限读
   `state.principalUsdt`。这个 bug 在模拟盘上永远看不出来——两者恰好相等。
2. **`ON CONFLICT` 的目标是 `(membership_id, strategy_code, book)`**。0060 换掉了
   原来的两列唯一约束；漏改会直接报「没有匹配的唯一约束」，表现是客户开通会员后
   进不去交易大厅。

**新增测试要跑到 official_paper_portfolios 的，记得应用 0060。** 仓库里有若干测试
自建 schema 子集或只应用部分迁移（`postgres-commercial-settlement`、
`strategy-runtime-repository`、`client-onboarding-hardening`），它们都需要显式加上
0060，否则报 `column "book" does not exist`。

**实盘落账的入口是 `postLiveFillsToBook`，输入是事实不是回执。**
`resolveEffectiveFill(回执, 对账记录)` 归一出事实；对账未决时**停住整条队列**，
不跳过去记后面那笔——跳过会让账本按错误顺序累计。

**开实盘之前先读 `LIVE_EXECUTION_BLOCKERS`。** 现在剩三条：余额核对缺失、
客户侧开通入口缺失、从未对真实交易所下过一单。清单不是开关。

### 一个反复出现的坑：两个时钟

测试里用冻结时钟的 Worker + 用数据库 `now()` 插入的到期时间 = 租约取不到刚插进去的
那条记录。本仓库已经踩过不止一次（`enqueueReconciliation`、以及这次的对账手续费
用例）。**插入待处理记录时，到期时间用测试时钟，不用 `now()`。**

## 51. 2026-08-23 V3 Phase 1：权限注册链接数据合同

分支 `codex/platform-v3-doc-sync` 已完成 Phase 1 的第一条代码切片，先把内部账号
注册链接的授权边界和不可变数据合同固定下来，尚未切换现有注册入口。

- 域层建立五级运营角色层级和向下授权规则：总部管理员可授权分公司管理员及以下
  角色，分公司管理员、经理、主管依次只能向下授权；员工不能再授权。
- 总部管理员创建分公司管理员链接时使用 `CREATE_BRANCH` 模式；创建经理及以下链接
  必须绑定既有组织。非总部角色只能继承自己的组织，不能跨组织发放权限。
- 迁移 `0065_internal_registration_links.sql` 将内部注册链接与客户邀请彻底分表。数据库
  只保存令牌摘要，并冻结目标角色、权限快照和组织范围；同一授权组合只允许一条有效
  链接，撤销不可逆，使用事实只能追加。
- 历史链接引用的专用角色和权限不可修改。后续签发服务必须为每条新链接建立专用角色，
  不能引用或冻结系统默认角色。
- 旧员工邀请仍保持“48 小时 + 审批”行为，直到新签发、注册、审计与兼容切换全部通过
  验证后再下线，避免半成品流程进入运营环境。

本切片验证结果：新增 13 个域层/Postgres 测试全部通过；全量 1241 个测试、TypeScript、
ESLint、三端生产构建和 bundle 预算均通过。构建仍有既存的 Node.js
`module.register()` 弃用警告，无新增构建错误。

## 52. 2026-08-23 V3 Phase 1：权限注册链接入口切换

分支 `codex/platform-v3-doc-sync` 已把第 51 节的数据合同接入实际签发、注册与账号管理
流程。第 51 节关于“旧流程暂时保留”的说明仅记录当时状态，以本节为当前实现基线。

- 内部员工账号改为可重复使用、可立即撤销的权限注册链接。注册链接冻结目标角色、
  权限快照和组织范围；数据库只保存 SHA-256 摘要，原始令牌通过 URL fragment 传递，
  不进入 Nginx 或 Next.js 的请求 URL 日志。
- 注册后账号和角色授权立即生效，不再产生待审批员工邀请。MFA 能力和既有凭证完整保留，
  当前由 `MFA_ENFORCEMENT_ENABLED=false` 暂停强制；正式生产三端统一设为 `true` 后，首次登录进入 MFA
  设置；匿名注册入口同时按邮箱、令牌摘要和网络来源三类桶限流，失败审计不保存明文
  令牌。
- 权限链接只在 Operations 签发和使用。Maintenance allowlist 已移除员工注册入口；
  客户邀请仍使用独立流程，不与内部账号链接复用数据表或权限模型。
- Operations 已移除“组织架构”页面和导航，新增扁平的“运营账号”目录。后端仍保留
  组织及上下级事实，用于权限范围计算，但前台不展示树形关系，也不允许直接创建员工
  或修改汇报关系；这两个旧接口现在明确返回 `410`。
- 停用下级账号会在同一事务中撤销其会话、未使用认证令牌以及该账号签发的全部有效
  权限注册链接。账号状态操作按五级角色和组织/直属/团队树范围做服务端校验。
- 生产数据库最小权限已同步：新链接表只允许 Operations 读取和写入必要字段，使用事实
  仅可追加，Maintenance 无访问权；API inventory、Nginx 生成配置和发布角色策略均已
  收敛到同一边界。

验证结果：内部链接服务新增 7 个 Postgres 集成测试，组织架构退役与账号停用新增 2 个
契约测试；全量 1252 个测试通过，TypeScript、ESLint、Client/Operations/Maintenance
三端生产构建、bundle 预算和仓库敏感信息扫描均通过。构建只有既存的 Node.js
`module.register()` 弃用警告。

Phase 1 尚未结束。下一切片是客户端账号安全：强制邮箱验证、最多 5 台设备、新设备/
异地登录提醒以及一键退出全部设备；随后补齐真实浏览器验收证据。

## 53. 2026-08-23 V3 Phase 1：Client 邮箱与五设备安全

分支 `codex/platform-v3-doc-sync` 已完成 T1.4 的核心实现，决策见 ADR-0022，数据迁移为
`0066_client_email_and_device_security.sql`。

- Client 注册现在要求有效国际手机号和邮箱。新身份保持 `pending`，24 小时邮箱验证成功
  后才激活；重发入口按邮箱和可信网络双桶限流，对外使用非枚举响应。
- 邮箱 bearer token 只存 SHA-256 摘要，Email outbox 只存 AES-GCM 密文；验证链接改用
  URL fragment，明文 token 不进入 Nginx/Next 请求 URL。
- Client 设备使用独立 256-bit HttpOnly Cookie，数据库只存摘要。同设备重登轮换旧
  Session；不同设备最多 5 台，客户行锁保证并发第 5/6 台不会同时成功。
- 新设备和已知设备跨 IP 网段分别产生站内与 Email 安全 outbox。页面只显示设备摘要、
  时间和脱敏 IP；完整 user-agent/IP 只留在受控 Session/审计数据。
- 账户安全页支持单设备撤销和一键退出全部 Client 设备；全量撤销包括当前 Session，提交
  后同时清 Cookie 并写审计。
- Client Web/Auth 的精确数据库 gateway、生产最小权限、API inventory 和三端 Nginx
  allowlist 已同步。新增验证重发 API 只存在于 Client 构建。

验证结果：全量 1263 个测试、TypeScript、ESLint、bundle 预算和敏感信息扫描通过。三端
生产镜像已在云端 `ssh an-saas` 使用仓库固定 Node 22.21.1 镜像构建，未启动或部署：

- Client：`sha256:e9861c19d036ecfd2e40288be8bf5f71efae5b22f01c2fbb58feebbfa727713e`
- Operations：`sha256:f1016b7eb13f104fe15944082aa30b2d5b60c434b2572437225ba3288f926e7f`
- Maintenance：`sha256:57f111689aa9a0ce4b02dc42c93d23b86cdd65c087044eafc43c651084f25d7a`

同一云端 Docker daemon 使用 `nginx:1.29.8-alpine` 完成真实 `nginx -t`，语法通过；只有
为兼容发行版旧 nginx 而保留的 `listen ... http2` 弃用警告。生产依赖
`npm audit --omit=dev` 为 0 漏洞；`npm ci` 的 17 项审计提示全部来自开发依赖。

T1.4 自动化范围已完成，但 G1 仍未关闭：需要四身份真实浏览器、多上下文撤销和真实邮件
送达/关闭降级证据。需求方还需确认第 6 台设备交互，以及是否要求城市级
定位；当前安全默认分别是“拒绝第 6 台”和“以 IP 网段变化作为异地证据”。

## 54. 2026-08-23 V3 Phase 1：MFA 暂停强制与三端登录实测

分支 `codex/platform-v3-doc-sync` 已按 ADR-0023 暂停三端 MFA 强制，但完整保留 TOTP、
恢复码、凭证和再次开启能力。`MFA_ENFORCEMENT_ENABLED` 当前默认 `false`；正式生产前
必须在三端同时开启并单独通过首次绑定、已绑定验证、恢复码、recent MFA、密码重置和
回滚 Gate，不能把本次关闭态证据替代生产开启态验收。

本次使用本地真实 Chromium 和空浏览器上下文逐端填写登录表单，Client、Operations、
Maintenance 均成功进入各自首页且未进入 MFA 绑定页。浏览器实测同时发现并修复两项
仅靠接口合同不容易发现的问题：

- 登录 API 在关闭态会签发完整内部 Session，但通用 Session assurance 仍按 MFA 开启态
  拒绝它，导致 Operations/Maintenance 登录成功后回到登录页；现在 assurance 显式接收
  服务端 enforcement 状态，默认仍保持强制，只有配置明确关闭时才允许无 MFA 的内部
  完整 Session。
- 权限注册链接从 URL fragment 读取令牌时，服务端空快照和浏览器首屏快照不一致，可能
  产生 React hydration 错误；现在使用带服务端空快照的 `useSyncExternalStore` 监听地址
  变化，浏览器注册路径不再出现 hydration 异常。

完整 Playwright 证据为 15/15，通过范围包括三端空浏览器登录、Host/Cookie audience
隔离、Operations 权限链接注册/角色冻结/作废、Client 五浏览器上限与第六台拒绝、跨
上下文全量退出、邮箱未验证重发和加密 outbox 降级，以及既有会员 maker-checker、三端
稳定路由、axe、console/network 边界。全量 1267 个单元/集成/合同测试、TypeScript、
ESLint、261 条 API 安全清单、架构边界和仓库敏感信息扫描均通过。

三端生产镜像在 `ssh an-saas` 的一次性目录
`/root/agentnovas-v3-g1.dPSIbN` 构建，源码传输显式排除 `.env*`、Git、依赖和本地输出；
镜像仅用于验证，未启动、未推送、未部署：

- Client：`sha256:40a53ef9bfd918c9c8e90e807a60c4392344ce83c7eeca7351b4519b2a137ea1`
- Operations：`sha256:63939142f4f2651719832d5f54b4e4b8b26a92d8192705bd760b8052a7a8926c`
- Maintenance：`sha256:ec451b7b6b79dd4db528db94ebe16cce0527d57ee9c359203b084b1e82c61967`

G1 仍保持进行中：真实邮件送达证据、正式生产 MFA 开启态专项 Gate、城市级定位是否需要
以及第六台设备是否改为“替换旧设备”的需求结论尚未完成。当前实现继续采用安全默认：
第六台直接拒绝，异地以 IP 网段变化为证据。

## 55. 2026-08-23 V3 Phase 1：MFA 开启态三端本地登录预检

本切片建立了与原关闭态门禁隔离的 `mfa-on` Playwright profile。默认 `npm run test:e2e`
仍强制 `MFA_ENFORCEMENT_ENABLED=false` 并保留 15 项期望数量；新增
`npm run test:e2e:mfa-on` 使用独立 `outputs/quality-mfa-on`、一次性 PostgreSQL Schema
和运行时密钥，精确启用 MFA，成功或失败后都删除 `.runtime` 与 Schema。未知 profile
直接失败，外部支付、邮件发送、Demo、Research/Runtime 写入继续全部关闭。

本机真实 Chromium 的开启态预检为 3/3：

- Client：空浏览器密码登录、账户安全页主动绑定、8 枚一次性 recovery code、另一个空
  浏览器 TOTP 登录、第三个空浏览器 recovery 登录；数据库只保存 AES-GCM TOTP 密文和
  recovery 摘要，并验证 recovery 单次消耗事实。
- Operations：空浏览器密码登录后强制首次绑定，保存 recovery code 后进入运营概览；
  再开空浏览器使用 TOTP 登录。
- Maintenance：空浏览器密码登录后强制首次绑定并进入系统概览；再开空浏览器使用
  recovery code 登录。

浏览器执行发现并修复了门禁自身的两个真实性问题：Client 关闭态完整会话在 fixture 中
仍错误标为 `primary`，与新的回滚安全语义冲突，现在改为 `none`；Next 16 的 standalone
构建不能再由 `next start` 可靠承载，runner 现在运行生成的 `standalone/server.js`，并
在启动前补齐 `public` 与 audience 对应的 static 资源。原关闭态套件随后重新通过 15/15。

安全收敛同步完成：

- MFA 验证和绑定确认同时使用 session、user、可信 connection 三层限流桶，轮换 primary
  Session 不能重置账户/网络尝试预算；生产无法解析可信连接身份时返回 503。
- 生产配置审计要求 Client、Operations、Maintenance 都显式配置精确 `true|false`，并且
  三端值一致；finding 不回显配置值。
- Client 关闭态可从完整会话主动预绑定；开关切换后，已绑定 Client 的旧 `none` Session
  不再绕过挑战，遗留内部 `primary` Session 也不会在关闭开关时被静默提升。
- 密码重置和内部激活链接使用 URL fragment 传递 bearer token，避免进入代理请求 URL。

验证结果：全量 1277 个测试、TypeScript、ESLint、架构边界和仓库秘密扫描通过；MFA
PostgreSQL fixture、共享限流和生产配置专项测试通过。三端生产 builder 在
`ssh an-saas` 的一次性目录 `/root/agentnovas-v3-mfa.Am8pou` 构建，源码传输排除了
`.env*`、Git、依赖和本地输出，未启动、未推送、未部署：

- Client：`sha256:73eabad739a232776cbd45972fdba252076517d7195e754bbbe019e665a870d8`
- Operations：`sha256:a1f0c0df12d1269676b49deb288e156e5f7fb6f9330bfe9400109b0c073e593a`
- Maintenance：`sha256:4c2f3de65df3479ea4d7ffd65879a438d2065473c4ca98af443aa51abbd9db27`

这仍是生产 Gate 的子集，不能把 T1.14 或 G1 标为完成。正式投入生产前还必须在目标环境
完成 recent MFA 敏感接口、密码重置 continuation、同一数据库 on→off→on 回滚、三端
readiness 一致性和真实邮件送达；产品侧城市级定位与第六台设备策略也仍待确认。

代码差异审计还发现 Phase 1 任务真源遗漏 Operations PII 字段权限/导出一致性，已补为
T1.6 / 1.15，后续应优先完成该切片，再进入多市场行情。

## 56. 2026-08-23 MFA 关闭态三端登录强制复验

在继续 Phase 1 之前，使用本地三套生产 standalone 服务和三个彼此隔离的真实 Chromium
上下文，再次执行 Client、Operations、Maintenance 空浏览器登录。三端均通过真实表单
填写与按钮提交进入各自首页：Client `/dashboard` 的“欢迎回来”、Operations `/` 的
“运营概览”、Maintenance `/` 的“系统概览”；三端均未进入“绑定双重验证”。浏览器
控制台、页面异常、本地失败请求、非预期 HTTP 4xx/5xx 和外部网络请求均为零。

首次尝试使用 development server 时，Next 开发态对正式 HTTPS Host 转发的静态资源、
CSP 和 HMR 产生预期外噪声，不能作为发布证据；切回生产 standalone 后又定位到登录
断言完成时首页后台请求仍在飞行，三个上下文立即并行关闭会与 Playwright Route 转发
形成竞态。验收用例现在逐端等待 `networkidle` 后再判定 MFA 未出现并关闭上下文，未
放宽任何 console、network 或 HTTP 错误规则。

最终专项命令以 `QUALITY_E2E_PORT_OFFSET=10` 使用本机 3010/3011/3012，结果为 1/1
通过；测试器专项单元回归 17/17 通过。MFA 保持默认关闭，正式生产前的开启态完整 Gate
仍按第 55 节要求执行。

## 57. 2026-08-23 V3 Phase 1：Operations 客户 PII 字段权限与导出一致性

T1.6 / todo 1.15 已完成。Operations 客户数据不再只有一条统一邮箱遮罩规则，而是拆成
四类显式敏感权限：完整联系方式、登录 IP/设备、累计充值/消费、交易所账户/持仓；另设
客户导出权限。五项权限均为 sensitive，默认运营角色不自动获得，现有 `hq_admin` 仍按
平台管理员合同持有全部 Operations 权限。MFA 当前关闭时可使用这些能力；正式重新开启
后，访问会自动恢复 recent MFA 门禁。

- 列表、详情和 CSV 共用 `projectOperationsCustomerPii` 投影。未请求字段保持遮罩、`null`
  或空集合；显式请求必须同时具备对应权限并提供 8–500 字业务原因。中文原因在请求头中
  采用 percent encoding，审计前会移除明显邮箱、电话和 IP，避免把客户明文复制到日志。
- PII 数据范围是 `ops.customers.view` 与每个所选字段权限范围的交集。范围或组织集合不相交
  时直接 403，不能用一个窄范围的 PII 权限读取更宽的客户目录；完整邮箱搜索也只在本次
  明确请求 contact 分类后启用。
- 联系方式来自客户身份与已验证通知渠道；注册网络来自最早 `customer.registered` 审计，
  最近网络/设备来自 Session；累计充值只统计 `CREDITED`，累计消费只统计 confirmed
  revenue；交易视图只返回安全账户元数据和未关闭持仓，绝不读取或返回加密凭证引用、
  提现凭证引用。
- 客户 CSV 改为 POST，同列表使用相同筛选和 scope，最多 5000 行；所有单元格先做公式
  注入防护再 RFC 风格引号转义。响应 `private, no-store`，服务端不保留文件，并分别记录
  生成与下载审计。API inventory 将三条客户读取/导出路由登记为 full PII，导出要求
  same-origin 与敏感权限。
- 数据迁移 `0068_operations_customer_pii_permissions.sql` 只登记权限，不给既有业务角色
  静默加权。Operations UI 提供字段分类、原因、临时展示和导出控件；无 PII grant 的
  maker 只能看到遮罩，显式授权的 checker 才能揭示相应分类。

浏览器验收期间发现并修复一个真实首屏 500：历史 `sessions.created_at` 为 text，后续
`last_seen_at` 为 timestamptz，新 PII 查询直接 `COALESCE` 会触发 PostgreSQL `42804`。
现在显式把历史时间转换为 timestamptz，并新增基于完整迁移链与质量 fixture 的回归测试；
简化表测试不足以发现此类迁移期类型差异。还修复了 PII 成功提示只在选中客户详情时可见
的问题，现使用独立全局 `aria-live` 区域。

验证结果：最终 `npm test` 1288/1288、TypeScript 与 ESLint 均通过。Client、Operations、Maintenance
生产 standalone 均在 `ssh an-saas` 的隔离目录 `/tmp/agentnovas-build-Yoc8mn`、固定
Node 22.21.1 容器内构建成功，未启动远端服务、未推送、未部署；Operations 在两项浏览器
修复后重新构建。最终本地生产产物真实 Chromium：三端空浏览器登录 1/1、maker 默认遮罩
与 checker 填写原因后显式揭示 2/2，console/page error/failed request/非预期 HTTP 均为零。
开发态 Host/HMR/CSP 失败仅作为无效尝试保留，不计发布证据。
`npm audit --omit=dev --audit-level=high` 为 0；远端 `npm ci` 报告的 17 项来自开发依赖，
未自动执行破坏性依赖升级。

Phase 1 仍未关闭：真实邮件送达与正式生产 MFA on→off→on、recent MFA、密码重置及目标
环境三端一致性 Gate 仍按第 55 节执行；不能用本节 MFA 关闭态证据替代。

## 58. 2026-08-23 Maintenance 普通配置去除冗余确认弹窗

Maintenance 配置体验已完成一次独立减负：普通、可逆的配置保存和只读连通测试不再先点
按钮、再弹出对话框、再重复填写原因。审计原因改为页面内字段，填写一次即可直接执行；
服务端权限、Origin/CSRF、输入校验、幂等和审计合同均未放宽。

- 平台与客服设置、邮件测试、数据/新闻源测试完全移除确认对话框。
- 模型 Profile 保存、Agent 绑定/停用和连通测试共用本轮页面内原因；模型历史回滚仍保留
  独立确认。
- 优盾币种映射和连通测试直接执行；启用或停用真实充值能力仍保留独立确认。
- Demo provider 连接验证直接执行；账户启停、Kill、恢复和策略卡停控仍保留独立确认。
- 商业披露发布/复核、版本发布、紧急暂停、权限/资金审批、恢复码轮换和会话撤销没有改动，
  继续遵守 PRD 的高风险二次确认要求。

新增共享 `InlineAuditReasonField`，提供可访问标签、长度提示和统一 3–500 字校验；Demo
连接验证按既有 API 合同使用 8–500 字。普通配置按钮只有在原因有效时才启用，提交期间
保持 busy 防重复点击，结果继续通过 `aria-live` 通知。

验证结果：`npm test` 1292/1292、TypeScript、ESLint 和定向合同测试均通过。Maintenance
production standalone 在 `ssh an-saas` 的临时目录
`/tmp/agentnovas-config-ux-build-o2T2Qq`、Node 22.21.1 容器内构建成功；未启动远端服务、
未推送、未部署。隔离 PostgreSQL 与本地真实 Chromium 的 Maintenance 套件 3/3 通过，
包含一次真实平台设置 PUT、六个配置页面无对话框、四档响应式、axe、console/network
检查。浏览器测试改用 3120–3122，避免干扰本机已有的独立 3002 服务。

## 59. 2026-08-24 T3.1a 通用版本化配置发布内核

Phase 3 的通用配置发布框架已先完成无外部产品参数依赖的内核/API 切片。迁移
`0069_versioned_configuration_framework.sql` 新增五张追加式表：配置版本、测试结果、
审批、调度和生效事实。配置流以 `(kind, configuration_key, audience)` 隔离并在事务内
使用 advisory lock 分配单调版本号；所有版本和事实表由触发器禁止 `UPDATE/DELETE`。

状态由事实投影为 `draft/test_failed/tested/rejected/approved/scheduled/active/
superseded/rolled_back`。创建者不能审批；最新测试未通过、未批准、未调度或未到期的版本
不能激活。回滚只能引用同一配置流里测试通过、审批通过且曾成功生效的历史版本。所有写入
绑定 actor、幂等键、requestId、原因和非秘密审计；并发重放只产生一条事实。

通用 payload 采用严格 JSON、64 KiB 上限、稳定 canonical SHA-256，并递归拒绝
secret/password/token/apiKey/privateKey 等字段。模型、支付和集成密钥仍留在既有只写不读
专用表。新权限分为 view/manage/approve/activate；技术角色只有 view/manage，审批和激活
必须另行授权。Client/Operations 数据库角色没有新表权限。

新增五个 Maintenance-only 路径（六个 method），覆盖列表/创建、测试、审批、调度和
激活/回滚，并同步中央 API inventory、OpenAPI、API Catalog、最小权限 SQL 和数据库角色
策略。API 只登记发布事实，不执行交易、支付、部署或任意外部副作用。

验证结果：定向合同 6/6、`npm test` 1298/1298、TypeScript、ESLint、secret scan 均通过；
`npm audit --omit=dev --audit-level=high` 为 0。Maintenance production build 在
`ssh an-saas` 的隔离目录 `/tmp/agentnovas-config-framework-build-f9jcQx`、Node 22.21.1
容器中通过，随后已删除目录；`npm ci` 的 17 项提示来自开发依赖。未启动服务、未迁移
生产数据库、未推送、未部署。

T3.1 整体仍未完成：T3.1b 的 Maintenance 工作台和最小权限到期激活器、T3.1c 的品牌/
域名/协议、功能开关、Prompt/技能和价格消费者仍待后续切片；P-07/P-08/P-10/P-11
继续阻断相应具体值和素材，不能用占位配置替代需求方结论。

## 60. 2026-08-24 T3.1b-UI 配置发布工作台与三端登录回归

Maintenance 新增稳定路由 `/configurations` 和权限导航，页面消费 T3.1a 的受控 API，提供
不可变草稿、版本历史、顶层字段差异、payload SHA、测试证据、独立审批、明确时区 offset/
UTC 预览、稳定游标历史加载、调度、current 投影、到期激活和历史回滚。计划时间的 offset
按目标日期计算，跨 DST 不复用页面打开当天的 offset。页面不读取或显示秘密字段；草稿和
测试证据、审批、调度、激活和回滚都使用页面内审计原因直接提交，不再用模态确认框打断
配置流程。权限分离、创建者不得自审、状态机前置条件、幂等键、busy 防重复提交和不可变
审计事实没有放宽；当前激活仍只改变尚未接管具体运行时的控制面 current 投影。

工作台用词保持事实边界：人工上传只称为“登记测试证据”，不会声称浏览器运行了测试；
在具体配置消费者接入前，active/current 也只表示控制面投影，不表示品牌、功能开关、
Prompt、技能或价格已经接管运行时。T3.1b-Worker 的到期扫描、租约、最小数据库角色和告警
仍为下一独立切片，T3.1 整体没有提前标记完成。

三端登录回归首次运行时，Client 已完成登录并渲染真实首页，但测试在成功后额外等待
`networkidle`，因首页持续受控请求耗尽 60 秒，Operations/Maintenance 没有执行。登录业务
逻辑未改；测试完成判据改为目标 URL、受众首页标题和无 MFA 强制绑定页，并新增合同防止
恢复 `networkidle`。隔离三端空浏览器登录随后 1/1（4.3 秒）通过，完整关闭态 Playwright
从过时的 15 项门禁同步为实际 18 项并最终 18/18 通过；Cookie Secure/HttpOnly/Strict、
Host/audience 隔离、设备上限、权限链接和三端 UI 均在同一生产产物套件中通过。

最终验证：`npm test` 1302/1302，TypeScript、ESLint、`git diff --check`、secret scan 和
production dependency audit 均通过。Client、Operations、Maintenance standalone 在
`ssh an-saas` 的 `/tmp/agentnovas-config-ui-build-bxeokz`、固定 Node 22.21.1 容器中构建；
最终 Maintenance 产物重建后真实 Chromium 3/3，通过四档宽度、axe、键盘、资源预算、
console/network 检查和一次无确认弹窗的草稿创建 201。远端未启动服务、未迁移生产库、
未推送、未部署。

配置全流程去除模态框后再次验证：定向 UI 合同 7/7、`npm test` 1302/1302、TypeScript、
ESLint、secret scan 和 production dependency audit 均通过。最新 Maintenance standalone
在 `ssh an-saas` 的 `/tmp/agentnovas-config-inline-build-MdtmTZ`、固定 Node 22.21.1 容器中
构建成功；同一产物下载到本地隔离测试仓后，关闭态完整 Playwright 再次 18/18 通过，覆盖
三端空浏览器登录、配置页真实草稿创建和全程无 dialog。质量 schema 与运行时凭证均已清理，
3002 上既有进程未停止或覆盖；远端未启动服务、未迁移生产库、未推送、未部署。

## 61. 2026-08-24 T3.1b-Worker 最小权限到期激活器

T3.1b-Worker 已完成。新增独立 Configuration Activation Worker，以全局 PostgreSQL session
advisory lease 保证单扫描者，按计划时间和版本 ID 稳定扫描最新测试通过、独立批准、已经到期且
从未生效的版本。默认每 5 秒、每批 50 条，边界限制为 1–30 秒与 1–100 条；每个候选由独立
SQL 语句处理，一个失败不会阻断整批，连接崩溃后 lease 由 PostgreSQL 自动释放。

Worker 不直接写 activation/audit 表，只能调用迁移 0070 提供的
`configuration_activation_worker_activate(text)`。该 `SECURITY DEFINER` 网关由 migrator
拥有，固定安全 `search_path` 并撤销 PUBLIC 执行权；它以数据库当前时间再次验证测试、审批、
到期和尚未生效，取得与人工激活相同的流级事务锁，再写入固定 worker actor、原因、幂等键、
激活事实和审计事实。调用方不能提供 actor、事实 ID 或任意审计文本。

专用登录角色 `agentnovas_configuration_activation_worker` 只有配置事实只读、自己的心跳读写和
该函数的 EXECUTE；没有审批、调度、回滚、secret、客户/支付数据、activation/audit 直接写入
或 sequence 权限。生产角色策略同时检查表/列级操作、函数 allowlist、函数 owner、
`SECURITY DEFINER`、`search_path` 和精确 grantee。Container Worker 只有 backplane 网络并使用
独立 `configuration-activation` profile；systemd、Compose 与环境示例默认关闭。生产配置审计
要求专用 DSN 及 Maintenance/Worker 开关一致，不回显配置值。

Maintenance 健康 API、合同与 UI 已加入该 Worker 的配置、存活、最近成功和受限错误投影；
60 秒无成功进入 warning，300 秒进入 critical。当前仅推进通用控制面 current，T3.1c 的品牌、
域名、功能开关、Prompt、技能和价格消费者仍未接入，绝不代表这些配置已经接管运行时，也没有
打开交易、支付、提现或部署能力。

验证结果：Worker PostgreSQL/角色/网关专项 20/20、部署与配置合同 23/23 通过；最终标准
`npm test` 1309/1309、TypeScript、ESLint、`git diff --check`、secret scan 和 production
dependency audit 均通过。第一次标准全量测试在多个迁移 fixture 并行建 schema 时触发
PostgreSQL `53200 out of shared memory`（`max_locks_per_transaction` 提示），没有业务断言失败；
连接释放后以完全相同命令重跑通过，保留为测试基础设施容量波动证据。

Maintenance production build 在 `ssh an-saas` 的一次性目录、固定 Node 22.21.1 容器内通过；
Runtime Docker target 也构建成功，生产依赖为 0 vulnerability，并确认以非 root `node` 运行且
包含 Worker 脚本与 0070 迁移，验证镜像随后删除。因机房代理/直连下载仅有几 KB/s，浏览器
产物改在本地隔离副本以同一源码和 Node 22.21.1 重建；关闭态完整真实 Chromium 18/18 通过，
覆盖三端空浏览器登录、权限注册链接、Host/Cookie audience 隔离、三端 UI、Maintenance 健康页
和配置无弹窗提交。质量 schema、运行时 secret、3200–3202 进程、远端构建目录均已清理；本地
隔离目录移入废纸篓。未启动远端服务、未迁移生产数据库、未推送、未部署。

## 62. 2026-08-24 T3.1c-FF1 策略研究全局功能开关

首个具体配置族 `feature_flag/client.strategy_research/client/schema v1` 已完成全栈接入，payload
严格只允许 `{enabled:boolean}`。其他 feature flag key、audience、schema 或附加 targeting 字段
均在草稿边界拒绝；用户/组织、应用版本、百分比和独立时窗继续留给 T3.3，不在 v1 猜测语义。

注册族测试不再接受浏览器填写 `result` 或 `evidenceSha256`。Maintenance 只提交 3–500 字审计
原因，服务端按 tester `feature-flag-v1` 对不可变 family/payload 生成确定性的 passed 与摘要并
写入追加事实；审计同时保留 tester ID。其他尚未注册配置族仍使用既有人工证据路径。创建页固定
key、Client audience 和 schema，只呈现模块开/关；详情页提供“运行确定性测试”，草稿、测试、
审批、调度、激活和回滚继续使用页面内原因直接执行，没有恢复模态确认框。

迁移 0071 提供 Client 唯一可执行的 `configuration_client_active_feature_flag(text)` 最小权限
网关，由 migrator 拥有、固定安全 `search_path`、撤销 PUBLIC 权限；Client 没有通用配置底表
权限。消费者重新校验 schema、严格 payload 与 canonical SHA-256，网关错误、非法投影或摘要
不一致全部失败关闭且不回显错误正文。策略研究 GET/POST 共用双重 Gate：环境变量为 false 时
完全不查询配置，环境变量为 true 且没有 active 版本时保持原行为，active false 只能关闭，
不能打开环境或其他能力 Gate 已禁用的功能；激活/回滚从下一次请求读取新的 current。

本地完整质量门禁为 `npm test` 1326/1326、TypeScript、ESLint、8 条架构边界、secret scan 与
production dependency audit 全通过。`ssh an-saas` 使用完整提交快照和 Node 22.21.1 容器完成
Client/Operations/Maintenance 三端 production build；首次归档仍在慢速传输时提前构建产生统一
module-not-found，确认快照不完整后作废，最终以文件数和关键 SHA 对齐的完整快照重建成功。

本地重新构建三端 standalone 后，隔离 PostgreSQL、MFA 关闭、外部写入全禁用的真实 Chromium
最终 18/18 通过。Maintenance 实际创建注册草稿、触发服务端测试并断言请求体只有 `{reason}`；
三端空浏览器登录、Cookie/Host audience、五设备、权限注册链接、响应式、axe、console、network
与 HTTP Gate 同批通过。验收还修复了 Playwright teardown 竞态：只在主动关闭隔离上下文后忽略
已被浏览器处理的 route；运行期错误仍 fail-fast。质量 schema、运行时 secret、3410–3412 端口
和两处远端临时目录已清理。未启动远端服务、未迁移生产数据库、未推送、未部署。

## 63. 2026-08-24 G1 本地 MFA 完整专项与 Client 密码重置修复

G1 本地 MFA 缺口已经收口，但正式生产 Gate 仍保持未通过。扩展后的
`test:e2e:mfa-on` 在外部写入全关闭、一次性 PostgreSQL schema 和真实 Chromium 中 3/3
通过：Client 主动绑定后分别使用恢复码和密码重置后的 TOTP 登录；Operations 首次绑定、TOTP、
密码重置后 primary-only Session、旧会话撤销和恢复码登录通过；Operations/Maintenance 把精确
Session 的 `mfa_verified_at` 回退到 16 分钟后，敏感权限 API 均返回
`RECENT_MFA_REQUIRED`，普通 Session 仍存在。

专项最初实际复现 Client `/api/auth/reset-password` 500。完整迁移链回归定位为迁移 0040 的
`client_consume_password_reset` 返回列 `user_id` 与函数内未限定 `WHERE user_id=...` 在
PL/pgSQL 中歧义（PostgreSQL 42702）。没有改写历史迁移；新增前向迁移 0072 对所有可变表列加
别名限定，重新固定 `pg_catalog` 优先的 `search_path`、撤销 PUBLIC/其他角色并只向
`agentnovas_client_web` 收敛执行权限。完整迁移链测试验证 token 单次消费、密码更新、Session
撤销和带 `row_hash` 的 `auth.password_reset` 审计。重置页同时兼容字符串与结构化安全错误，
避免把错误对象直接交给 React 渲染。

新增 `test:e2e:mfa-rollout` 使用同一隔离 schema 依次以 `true → false → true` 重启 Client、
Operations、Maintenance。9 条旅程证明关闭时三端可直接登录，重新开启后关闭期签发的无 MFA
Session 不能继续认证，三份 TOTP 凭据未被删除且仍可完成挑战。最终证据记录
`offSessionsRejectedAfterReenable=true`、`activeCredentialsPreserved=3`；schema、运行时凭据和
3610–3612 端口均已清理。当前完整门禁为 `npm test` 1329/1329、TypeScript、ESLint、8 条
架构边界、secret scan、production dependency audit 与本地三端 production build 全通过。
正式生产仍必须三端同步开启并在目标环境执行相同专项、真实邮件与批准的变更/回滚流程。

云端构建使用本次精确暂存树 `0c30fa095ac98e4995a10d82d91020e565f871b0`，归档包含 3062 个
文件；归档、迁移 0072 和重置页 SHA 在本地与 `ssh an-saas` 一致。Node 22.21.1 容器内
`npm ci` 后 Client 68 页、Operations 62 页、Maintenance 51 页 production build 全部成功。
云端 `npm ci` 报告的 17 项为开发依赖审计结果；本地 `npm audit --omit=dev --audit-level=high`
为 0。远端 `/tmp/agentnovas-mfa-build-BvKxAg` 与本地临时归档已删除并复核不存在；未启动服务、
未执行迁移、未接触生产数据库、未推送、未部署。

## 64. 2026-08-24 T0.3 Current → V3 详细能力矩阵

T0.3 已完成，并把原来偏“旧运营后台迁移”的矩阵升级为全平台 V3 可执行盘点。新矩阵按
身份、行情、Maintenance 配置、AI/策略市场、真实交易、资金出站、发布与正式收口逐项标记
`CURRENT/PARTIAL/TARGET/BLOCKED/RETIRED`，每项同时列出可复用 route、数据库、三端页面、
Worker/Execution Service、测试证据、目标位置和剩余 Gate。P-01–P-12 未决参数没有用技术假设
填充，相关切片继续保持阻断。

数量采用机器或数据库 catalog 口径而不是手工猜测：中央 inventory 为 203 个 route 文件、
268 个唯一 method route（其中 61 个当前硬关闭、154 个 mutation）；页面 dispatcher 合同为
Client 27、Operations 24、Maintenance 21，共 72 个 route pattern；完整 73 个迁移在一次性
PostgreSQL schema 应用后得到 153 张表（含迁移登记表）、5 个 view、67 个 routine、50 个
trigger、10 个 policy 和 5 个 sequence，查询后 schema 已删除。后台进程盘点为 6 个 Worker
加 1 个 Execution Service；测试目录有 269 个文件（267 个可执行 test/spec 和 2 个 Playwright
支持模块），基线 Node 套件证据为 1329/1329。

同时修正 `API_CATALOG.md` 中已经过时且彼此冲突的 197/261/258 统计为当前 203/268，并同步
文档状态矩阵、文档入口和任务真源。矩阵特别区分“Next build 总 route 数”和“页面 pattern”，
也明确表或 disabled route 存在不能证明 V3 能力已完成。下一可独立实施的无外部参数切片是
Prompt/Skill 配置族，但其可编辑边界、Skill 语义、可信测试方式和版本生效规则仍需需求方确认；
在确认前不进入实现。

## 65. 2026-08-24 T3.1c-FF2 多粒度功能开关

`client.strategy_research` 已在保持 schema v1 `{enabled:boolean}` 兼容的同时增加严格 schema
v2。v2 只允许一条显式规则，支持内部用户 ID、组织 ID、精确 `v` 前缀 SemVer、0–100 整数灰度
百分比和带明确 offset 的独立启停时窗；规则至少包含一个条件。用户与组织在主体维度内 OR，
主体、版本、百分比和时窗跨维度 AND；开始时刻包含、结束时刻不包含。列表规范化为去重排序，
用户/组织各不超过 100 个、应用版本不超过 20 个，邮箱等 PII 在边界拒绝。

灰度按 `SHA-256(flag key + ":" + userId)` 稳定映射到 0–9999，不按请求随机。运行时不接受浏览器
提供的 targeting 上下文：用户 ID、组织 ID 来自已认证 Session，应用版本来自服务端发布元数据，
时间来自服务端；环境变量 Gate 始终是能力上限。消费者会重新规范化 payload 并复核 canonical
SHA-256，未知 schema、无效投影、摘要不一致和数据库网关异常全部失败关闭，不回显配置或错误
正文。策略研究 GET/POST 在认证后共用同一判定，Client 仍只执行迁移 0071 的最小权限 current
网关，没有配置底表读取权。

Maintenance `/configurations` 增加“全局开关 v1 / 定向规则 v2”选择，定向字段在同一页面内
完成，提交草稿、服务端确定性测试、审批、调度、激活和回滚均继续使用页面内审计原因，没有
恢复确认 dialog。PostgreSQL 回归实际发布并规范化 v2，current 网关返回 schema 2/payload，
随后回滚到已验证 v1；浏览器断言草稿请求体为 schema 2、25% 稳定灰度，测试请求仍只有
`{reason}`。

本地完整门禁为 `npm test` 1333/1333、TypeScript、全仓 ESLint、8 条架构边界、secret scan、
`git diff --check` 与 production dependency audit 0 vulnerability。云端以提交 `4e21989`、tree
`8da9cf6687bd20c573c54d246bdd86f53553eec5` 的 3062 文件 Git 快照构建，归档 SHA-256 为
`0888becbdf8a0b3b4e33077b93248f0dc955dd0adfbde28e8b215afb4b594868`；`ssh an-saas` 的
Node 22.21.1 容器完成 Client 68 页、Operations 62 页、Maintenance 51 页 production build。
三份云端 standalone 归档 SHA-256 为
`93cc0aea66e40b6743e4c758914a63664fc503b0b1b0c5fec3863a7f0ef86214`，下载到本地后以隔离
PostgreSQL、MFA 关闭、外部写入全禁用运行真实 Chromium，最终 18/18 通过，覆盖三端空浏览器
登录、Host/Cookie audience、权限注册链接、五设备、三端 UI、v2 配置和无 dialog。

一次开发模式预跑被 Next 16 `allowedDevOrigins` 对正式测试域名的 403 挡在资源加载阶段，没有
进入业务断言，因此不计验收证据，也没有放宽开发服务器安全配置；随后使用云端 production
standalone 完成有效验收。质量 schema、运行时密钥、3740–3742 端口、下载产物及云端
`/tmp/agentnovas-ff2-build-1Mlb23` 均已清理，本机原构建缓存已恢复。未启动远端服务、未执行
生产迁移、未接触生产数据库、未推送、未部署。

## 66. 2026-08-24 T2.1a/T2.1b 多市场统一合同与当前目录

T2.1a 已新增 provider 独立的 market/provider/calendar/capability 公共合同、严格 normalizer、
版本化事件 envelope 和服务端行情新鲜度派生。ID、枚举、IANA timezone、UTC timestamp、
sequence、数组数量和目标阈值均受限；未知字段和重复值失败关闭。`quality/canOpenPosition` 不接受
浏览器输入：时间非法、超过声明的 latency 目标或达到 stale 阈值时均不能获得自动新开仓资格。
这只是确定性安全输入，不代表 Runtime/live Gate 已通过，也不影响安全平仓的独立规则。

T2.1b 把当前 40 个静态标的映射为 crypto-global、equities-us、forex-global 和 metals-global
四个当前市场，提供 canonical instrument ID、market、asset class、quote currency 和公共
provider symbol mapping。当前只声明 REST、display/research、display-only；没有把现有页面请求
冒充 WebSocket，也没有虚构 A/HK/KR/JP provider、授权或标的。`GET /api/market/instruments` 采用
加法式 contract v1，保留旧 `instruments/updatedAt/source` 和每个 instrument 原字段，当前
Client 因而无需迁移即可继续运行。

TDD 先后观察到合同模块不存在和目录模块不存在的预期 RED；安全审计补充了超长 ID、sequence、
timezone 与大数组滥用边界；最终复核又以 RED 抓到从展示 label 猜 canonical 元数据的规格违约，
改为 40 条显式 metadata 清单和缺项/重复检查。最终 22 项行情定向测试、`npm test` 1348/1348、TypeScript、全仓
ESLint、8 条架构边界、三端 key-custody、secret scan 与 production dependency audit 0 均通过。
本机无 Docker 时 nginx Gate 明确失败，随后在 `ssh an-saas` 用真实 Docker daemon 和
nginx 1.29.8 补跑通过；`listen ... http2` 为脚本记录的兼容警告。

云端构建使用提交 `7279688`、tree `ce86c1f789286e041cd0a03614336b6e78f6487f` 的 3066 文件
Git 快照，归档 SHA-256 为 `a61e7b68d68a5d068b64938280632645d946a9b5701f393416ed555f02a99da7`。
Node 22.21.1 容器完成 Client 68、Operations 62、Maintenance 51 页 production build；云端
production-only audit 同样为 0。API 为纯加法且 UI 未消费新字段，按规格没有重跑视觉专项；
本轮同分支此前 production Chromium 18/18 已覆盖三端空浏览器登录，未来 UI 消费新合同时必须
在当前产物重跑。两处用户本地改动哈希保持
`845633aa0d007944dfc3aeb7fc3eef2c53d487f1` 和
`fdb1530dda87b024e5088471eaa99122d394acfb`，未纳入任何提交。所有本地/远端临时目录已清理；
未启动服务、未执行迁移、未接触生产数据库、未推送、未部署。

## 67. 2026-08-24 T2.2a provider 独立行情流状态机

T2.2a 在 `packages/contracts` 增加无 I/O 的行情流状态机。sequence 以最多 128 位 canonical
十进制字符串保存并用 `BigInt` 比较；cursor scope 固定为 provider/market/instrument，重复、乱序
或 scope mismatch 都不会推进 cursor，也不接受浏览器附加 reset 字段。cache 按调用方提供的 UTC
时间和 stale 阈值派生，达到阈值后只允许展示并明确禁止新开仓；非法时间或超过五秒的未来时间
失败关闭。连接状态只由服务端输入派生为 connecting/live/stale/reconnecting/offline/invalid，
重连退避从 250ms 指数增长到 10 秒封顶。10 秒不是已验证恢复承诺，fresh 也只是 Runtime admission
的必要条件，不替代后续确定性风险 Gate。

TDD 覆盖任意精度 sequence、重复/乱序、scope 变化、canonical 输入、stale 等号边界、未来时间、
六种连接状态和退避上限，共新增 9 项测试。代码提交 `839f0e1` 后，全量 `npm test` 1357/1357、
TypeScript、全仓 ESLint、8 条架构边界、repository secret scan 与 production dependency audit
均通过。本切片没有真实 WebSocket/provider adapter、网络、数据库或 UI 变化，因此没有单独运行
浏览器或云端 build；T2.1 的精确提交云端构建仍是前一可部署证据，实际 adapter/UI 消费时必须
重跑三端 production build、登录和行情故障注入 Gate。两处用户本地改动继续未纳入提交；未启动
远端服务、未迁移数据库、未推送、未部署。

## 68. 2026-08-24 T2.11a Runtime 已收盘 K 线与 cadence 准入

T2.11a 关闭了当前 Runtime 的两条真实行情安全缺口。公开 Binance-compatible K 线响应会包含
正在形成的当前尾项，旧 Worker 只检查数值和顺序后直接选择最后一根，可能在收盘前形成决策。
现在 provider 原始项先完整校验，再按 Worker 注入的 `evaluatedAt` 只保留
`closeTime <= evaluatedAt` 的已收盘 K 线；少于两根时失败关闭，不补造、不猜测。

新纯域层准入按策略 timeframe 与 30 秒收盘容差判定：当决策 K 线年龄达到
`timeframe + 30s` 时为 stale。引擎不接受浏览器 freshness，要求服务端提供行情时间并复核
timeframe 与本轮最后 K 线 closeTime；缺失、错配、未知周期、未来或越界时间全部 invalid。
stale/invalid 只拒绝 `enter_long/enter_short` 并写入七阶段行情证据与拒绝原因，已有仓位的 exit
仍然生成意图，避免失败安全变成无法离场。共享卡级决策轮与逐组合准入使用同一状态。

TDD 先观察到模块不存在，再覆盖未收盘过滤、精确 stale 等号、未知/未来/越界时间、身份错配、
缺失输入、stale entry 与 stale exit，共新增 7 项。PostgreSQL Runtime 22/22 使用带真实当前
未收盘尾项的 fixture，证明决策轮绑定上一根已收盘 K 线并在下一根收盘后正常推进。代码提交
`da89d1c` 后全量 `npm test` 1364/1364、TypeScript、全仓 ESLint、8 条架构边界、三端
key-custody、repository secret scan、production dependency audit 和 `git diff --check` 全通过。
本切片仍不证明 stream latency/sequence、主备切换或 G2；T2.11b 等待真实 adapter 与 P-01/P-03。

云端使用文档提交 `940389985fd391b3222a14f175a83495708fc486`、tree
`106252134186539c5a0b2c54a46a95dadfb0697f` 的 3070 文件 Git 归档，archive SHA-256 为
`5df16d8077a3daf28e57d484c1adf4bece9f902cbb34bc04da8ed6c6dbd754f2`。`ssh an-saas`
固定 Node 22.21.1 容器完成 Client 68、Operations 62、Maintenance 51 页 production build，
云端 production-only audit 为 0；`npm ci` 报告的 17 项均来自开发依赖，没有执行自动升级。
本切片没有 UI、认证或 route 变化，未把窄浏览器重跑当成新证据；最终阶段仍必须在最新完整产物
重跑三端空浏览器登录。远端两个本轮一次性目录已删除，不可恢复但只含可重建源码/依赖/构建产物。
两处用户本地改动未纳入提交；未启动远端服务、未迁移数据库、未推送、未部署。

## 69. 2026-08-24 Maintenance 配置与控制流程去除确认弹窗

Maintenance 配置和控制工作台已统一改为页面内说明、必填审计原因和直接提交，不再使用确认
dialog。覆盖模型回滚、支付通道启停、商业披露提交与复核、平台 Demo 账户及策略卡控制、版本登记/
复核/部署证据登记和官方 Paper 紧急暂停/恢复。按钮只有在原因满足长度约束且页面不处于 busy
状态时才可执行；原有 RBAC、recent MFA、maker/checker、创建者不得自审、状态机、服务端校验、
不可变审计和幂等语义均未放宽。复核还发现旧紧急控制 UI 未发送服务端已强制要求的
`Idempotency-Key`，现已补为失败重试复用同一键、成功后才轮换。

需求与规格提交为 `7b71b69`，实现提交为
`773ef5b92387d308e7e356d6b61b3a5558e722e2`，tree 为
`76546b29127dd74debe85301233d987fbc356098`。完整本地门禁通过：`npm test` 1364/1364、
TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、repository secret scan（3070 个候选
文件）、production dependency audit 0 vulnerability 和 `git diff --check`。

云端使用上述精确提交的 3070 文件 Git 归档构建，源码归档 SHA-256 为
`8e32fe289231dd8a89e28ad30ab48e49e030006fcf878aef90109bb51d37dade`；`ssh an-saas`
固定 Node 22.21.1 容器完成 Client 68、Operations 62、Maintenance 51 页 production build，
云端 production-only audit 为 0。三端 standalone 及静态资源归档 SHA-256 为
`06b3da35117ce7e265a186f1596085fca1ea4bc4effab64d20b0d884b278bf9f`，下载前后摘要一致。

本机以云端产物、隔离 PostgreSQL schema、MFA 默认关闭和全部外部写入关闭运行真实 Chromium，
最终 18/18 通过：三端空浏览器登录、Host/Cookie audience 隔离、权限链接、五设备、三端 UI，
以及 Maintenance 配置和紧急控制页面内直接提交且全程无 dialog。浏览器用例在变更紧急暂停状态后
恢复初始状态；本轮 schema、运行时密钥和 3740–3742 端口均已清理。工作区既有
`app/api/auth/me/route.shared.ts` 与 `tests/api-policy-security.test.mjs` 修改未纳入提交；远端只使用
一次性构建目录且验证后已清理，未启动服务、未执行生产迁移、未接触生产数据库、未推送、未部署。

## 70. 2026-08-24 T2.3a provider 无关主备行情仲裁合同

T2.3a 在 `packages/contracts` 增加纯确定性的单周期来源仲裁，不建立 socket、不访问数据库、
不选择真实供应商。调用方必须提供有序 source policy、精确 provider symbol、canonical
market/instrument、服务端评估时刻、每 provider cursor 和明确的价格偏差/最少一致来源/参考价
年龄上限。候选只有同时通过 symbol、scope、sequence、新鲜度和价格完整性检查才有新开仓资格；
返回值只是 Runtime 风险 Gate 的必要输入，不替代授权、账户、策略或 named live Gate。

价格使用有界十进制字符串和 `BigInt` 缩放，不经过 JavaScript 浮点。对抗性审查先用 RED 证明
4 个来源形成 2 对 2 的冲突价格簇时旧实现会按优先级误选，随后收紧为只有唯一且内部一致的最高
共识簇可用；并列冲突必须由另一个 provider 的 fresh reference 消歧，否则全部 unavailable。
候选不能以自身历史参考价自证。共享行情 freshness 同时修正“receivedAt 晚于 evaluatedAt 仍被
判 fresh”的时间完整性缺口，现统一失败关闭。

实现提交 `ef18d71`。新增 14 项仲裁合同测试，相关行情/流/route/Runtime 定向 46/46；全量
`npm test` 1378/1378、TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、repository
secret scan（3073 个候选文件）、production dependency audit 0 和 `git diff --check` 均通过。
本机没有 Docker/nginx，因此 nginx 检查按脚本明确停止，云端构建时补跑。两处用户本地改动没有
纳入提交。T2.3b、真实 provider、持续防抖/切回、gap/reset/replay、故障注入和 G2 继续等待
P-01/P-03 与 provider fixture；未启动服务、未迁移数据库、未推送、未部署。

云端使用文档提交 `122317a5e38a13b7bb4c88a28d133108cfcc1a02`、tree
`dac2525587f56508d7d7924acdf52167de66247f` 的 3073 文件精确 Git 归档，archive SHA-256 为
`8d95d90502f5890cdd0ce1a08e2102062662a96b8a8e8abfa354d8013a6423cd`。`ssh an-saas` 的
Node 22.21.1 容器完成 Client 68、Operations 62、Maintenance 51 页 production build，云端
production-only audit 为 0。官方 nginx 1.29.8 `-t` 在宿主可见的一次性证书/挂载路径下通过；
保留脚本已记录的 8 条 `listen ... http2` 兼容警告。

本切片没有认证、route 或 UI 变化，未把无关的窄浏览器重跑记录为新证据；同分支最近一次云端
production standalone 的本地 Chromium 18/18 已覆盖三端空浏览器登录，最终整体收口仍须在最新
完整产物强制重跑。远端 `/tmp/agentnovas-market-arbitration-build-thDYNi` 与本地上传目录已逐项
删除并验证不存在，仅移除可重建源码、依赖和构建产物；未启动远端服务、未执行生产迁移、未接触
生产数据库、未推送、未部署。

## 71. 2026-08-24 T3.11a 公开 Client 语言偏好基础

T3.11a 建立唯一七语言 allowlist 与纯解析合同：canonical saved preference 优先，其次最多 16 个
有界 `navigator.languages` 候选，最后固定 `en-US`。浏览器匹配覆盖语言别名、大小写、下划线和
中文 script/region，但不读取 IP、GPS、时区或设备指纹；损坏 localStorage 值不会进入动态路径。

公开 Client 着陆页首屏改为英语，非英语仍通过固定模块按需加载；匿名选择保存在平台命名空间
localStorage，存储不可用时不阻断页面。自动推断与人工切换使用递增请求序号，旧异步结果不能覆盖
新选择。审查同时把 skip link、首页/流程/Demo 环境 aria 和 Demo 账户标签从硬编码中文迁入七语言
字典，避免英语首屏混杂中文。平台设置代码默认值同步为 `en-US`，但没有迁移用户数据库，也没有
声称已登录三端、认证/错误页、邮件或全站格式化完成。

规格提交 `02f1582`，实现提交 `81b86bc`。新增 7 项合同测试，定向 31/31、全量 1385/1385、
TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、repository secret scan（3076 个候选
文件）、production dependency audit 0 和 `git diff --check` 均通过。两处用户本地修改未纳入
提交；T3.11b 与六主题继续分别等待语言范围确认和 P-10，未推送、未部署。

浏览器旅程提交为 `d6b6c5f`。云端使用该提交、tree
`259f69cb7cd592881151dc03d478b32ac0d3b287` 的 3076 文件精确 Git 归档，源码 archive
SHA-256 为 `b738db75c7f75b2daeeb11b56af0d91d3ffc820d9e5211c2717bfd4b7407bd96`。`ssh an-saas`
固定 Node 22.21.1 完成 Client 68、Operations 62、Maintenance 51 页 production build，云端
production-only audit 为 0；官方 nginx 1.29.8 `-t` 通过并保留 8 条既有 http2 兼容警告。

三端 standalone 归档 SHA-256 为
`a9968e2ce63e544467baf7ea2d8f06349c3f0c0d73cdda2b134b8c0eaa773329`，第二次完整下载前后摘要
一致；第一次下载因命令输出窗口中断而摘要不匹配，未解压、未用于测试。完整产物在本地隔离
PostgreSQL、MFA 关闭、全部外部写入禁用下运行真实 Chromium 18/18：新增语言旅程覆盖空存储
英语 fallback、中文浏览器推断、人工西班牙语跨刷新优先和损坏值回退；其余旅程继续证明三端
空浏览器登录、Host/Cookie audience、权限链接、五设备、三端 UI 与 Maintenance 无确认弹窗。

质量 schema `quality_e2e_1787516846142_46538_8bd59011` 已删除，运行时秘密移除且无清理失败；
测试前本机三份 build cache 已恢复。远端 `/tmp/agentnovas-locale-build-wNeSUO`、本地上传/下载与
缓存备份目录均已删除，仅移除可重建源码、依赖和产物。两处用户文件哈希仍为
`845633aa0d007944dfc3aeb7fc3eef2c53d487f1` 与 `fdb1530dda87b024e5088471eaa99122d394acfb`；
未启动远端服务、未迁移生产数据库、未推送、未部署。

## 72. 2026-08-24 T3.11b1 新账号数据库语言默认与写入边界

T3.11b1 只完成不依赖三端偏好语义的数据库底座。forward migration `0073` 把
`users.locale` 的新行默认从 `zh-CN` 改为 `en-US`，并增加七语言 `NOT VALID` CHECK。该约束保留
历史未知值且不执行批量更新，但对 migration 之后的新 INSERT/UPDATE 失败关闭；migration 可在
runner 事务中重放，SQLite/Drizzle 兼容 schema 的默认值也同步为英语。没有新增用户修改 API，
没有决定 Maintenance 默认值是否覆盖英语，也没有扩大 T3.11b2 的全站翻译范围。

实现提交为 `bfeb9bb`。locale 合同与实际 PostgreSQL 定向测试 8/8；完整 0000–0073 migration
链、质量 fixture、密码重置与并发 migration runner 共 3/3；全量 `npm test` 1386/1386、
TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、repository secret scan（3078 个候选
文件）、production dependency audit 0 和 `git diff --check` 全部通过。两处用户本地修改仍未纳入
提交。纯数据库默认/约束切片没有 UI 或认证路由变更，因此不重复运行窄浏览器用例；同分支紧邻的
T3.11a 云端产物已完成真实 Chromium 18/18，最终整体收口仍会在最新完整产物重跑。

云端使用文档提交 `93d63fe5ea5530cc50c3c0f94253760da301fdec`、tree
`487fcb9ab7d683cf1dbeb628d7fa1f263e8fb0e8` 的 3078 文件 Git 归档；本地与 `an-saas` 接收摘要
均为 `ffd92552e168e90d9cf427d22c4b75ef72f07a7ee8fecea910a5ab7258c7f50d`。固定 Node 22.21.1
完成 Client 68、Operations 62、Maintenance 51 页 production build，production-only audit 为 0。
`npm ci` 的 17 项报告均来自开发依赖，没有自动升级；官方 nginx 1.29.8 `-t` 通过并保留 8 条
已知 `listen ... http2` 兼容警告。远端 `/tmp/agentnovas-locale-db-build-G3BOpC` 与本地上传目录已
逐项删除，只含可重建源码、依赖、构建和测试证书；未启动服务、未执行生产 migration、未接触
生产数据库、未推送、未部署。

## 73. 2026-08-24 T4.4a 可编辑结构化策略候选

客户现在可以在多 Agent 研究候选首次保存前展开完整结构化 JSON 并编辑全部 DSL 白名单参数。
浏览器本地 JSON 错误以内联 `role=alert` 呈现且不发请求；服务端仍按 V1–V3 重新规范化与校验，
未知字段、任意代码和越界风险失败关闭。只改变格式或字段顺序保留原验证标签，任一语义变化都保存
为 `manual + UNVERIFIED`，原评分与回测指标立即隐藏并明确显示“需重测”。保存后的版本不可原地
覆盖，页面采用服务端 canonical 结果并锁定编辑器，轮询或刷新仍读取已保存版本。

服务端提交为 `cffdd4b`，Client 提交为 `795f552`；候选级 PostgreSQL advisory transaction lock
串行化并发保存，相同不可变输入重放同一版本，不同输入返回冲突，崩溃窗口恢复也必须核对实际 DSL
与标签。浏览器/质量夹具提交为 `e020240`、`31a8c0f`、`19e516e`。关闭态质量 runner 没有为测试
放宽 `STRATEGY_RESEARCH_ENABLED=false`：Chromium 用有状态本地路由投影验证 UI 请求体、201 响应、
刷新保持和零 deployment 请求；服务端降级、所有权、不可变关联、幂等与事务并发由领域/PostgreSQL
测试独立覆盖，未用浏览器 mock 冒充服务端持久化证据。

最终本地 `npm test` 1394/1394、TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、
repository secret scan（3083 个候选文件）、production dependency audit 0 和差异检查全部通过。
首次全量运行遇到测试间临时 PostgreSQL role teardown 竞争，设备/Session 文件单独重跑 4/4，随后
完整重跑 1394/1394；没有通过修改业务代码隐藏夹具竞争。

云端使用提交 `e0202404167b6d2f4863593a4333bb42fd5fbf3c`、tree
`bdbe698dd5391518fa176fc5c12bbef0572d2001` 的 3083 文件精确 Git 归档；本地与 `an-saas` 的归档
SHA-256 均为 `d375229b0d6ec149c7e6e2f5878c23cd3235bc07b9a5d18510e46833c048785b`。固定 Node
22.21.1 完成 Client 68、Operations 62、Maintenance 51 页 production build，production-only
audit 为 0；官方 nginx 1.29.8 `-t` 通过并保留 8 条既有 http2 兼容警告。后续两个提交只修正
Playwright 交互/投影夹具，没有改变云端 runtime 源码。

三端 standalone 归档 SHA-256 为
`a79cb4eff2df4ce084b0b427e4ef62e63b726cb1a655da0165f806c6de702573`，下载前后一致。本地以该云端
产物、隔离 PostgreSQL、MFA 默认关闭和全部外部写入禁用运行真实 Chromium，最终 18/18 通过：覆盖
三端空浏览器登录、Host/Cookie audience、权限链接、五设备、客户端候选编辑/降级/刷新、Operations
权限和 Maintenance 无确认弹窗。质量 schema `quality_e2e_1787518971620_62772_16cabcf7`、运行时
密钥、3740–3742 端口、本地/远端临时产物均已清理，测试前 cache 已恢复。两份用户本地修改未纳入
提交；未启动远端服务、未执行生产迁移、未接触生产数据库、未推送、未部署。T4.4b 继续等待
T2.4/P-01，不因 4.4a 完成而提前解除。

## 74. 2026-08-24 T2.4a provider-independent 行情源绑定合同

T2.4a 已建立不依赖真实 provider 的行情源选择与不可变解析合同。选择意图只允许“跟随客户账户”
或“独立 provider”；账户一致模式要求服务端账户快照证明归属、启用、只读和 provider 完全匹配，
独立模式拒绝账户旁路。`customer_account` 来源必须携带与选择一致的精确账户证据，公共/授权来源
必须显式 `sourceAccountId=null`，不能把平台源伪装成客户账户源。

解析结果分别生成 `sourcePolicyFingerprint` 与 `bindingInstanceFingerprint`：前者绑定计算/数据源策略，
后者再绑定策略版本、选择模式和账户来源。两个摘要都使用版本化 JSON tuple，字段插入顺序不会改变
结果；相同平台 policy 可跨账户复用计算证据，但 binding instance 仍不同。所有结果只允许
display/research，明确 `authorizesOrders=false`；没有隐藏默认、Coinbase 特例、execution usage 或
浏览器自报健康/授权路径。

规格提交为 `ae2015c`，实现提交为 `c9d1d90`。17 项新合同测试覆盖账户/平台源隔离、双摘要、
字段顺序、非法旁路、未知字段和边界，相关行情合同定向 48/48；包含后续权限配置切片的最终完整
回归为 1411/1411，TypeScript、全仓 ESLint、8 条架构边界、三端 key-custody、repository secret
scan（3086 个候选文件）和 production dependency audit 0 全部通过。T2.4b 的持久化、API、UI、
Runtime、历史 `legacy_unpinned` 迁移与决策轮 aggregate hash 仍等待 P-01/provider registry；纯合同
完成不解除 G2 或真实 provider Gate。

## 75. 2026-08-24 权限配置流程移除冗余弹窗

Operations 与 Maintenance 共用的权限中心已把角色创建、角色模板发布、草稿角色发布和用户分配
改为页面内审计原因并单击执行，不再先点动作、再弹窗、再重复填写原因。同一角色原因可连续用于
本轮创建/发布，按钮在 3–500 字原因有效前保持禁用，提交期间继续使用 busy guard。敏感角色、模板
和分配仍只创建 maker/checker 申请，不会因为取消前端弹窗而直接生效；审批决定、角色撤销、恢复码
和设备会话等独立高风险动作仍保留显式确认。

实现提交为 `ddb213d809c81be321a8d97bd6bfba251790d6fb`，tree
`8708a2d55bd9f267dbf93a3c16b32f818b5985e8`。UI 合同先 RED 证明普通配置仍依赖 dialog，再 GREEN
锁定三个内联原因区与普通动作不再写入 `pending`；全量 1411/1411、TypeScript、全仓 ESLint、
8 条架构边界、三端 key-custody、repository secret scan、production dependency audit 0 和差异
检查均通过。

云端使用 3086 文件精确 Git 归档，源码 archive SHA-256 为
`d2ade97ea3d95ec4ac05346533f3fcd6ec057e615e7ff975d85190124f6af821`。`ssh an-saas` 固定
Node 22.21.1 完成 Client 68、Operations 62、Maintenance 51 页 production build；三端镜像摘要
依次为 `sha256:1bd0b9ae5b27d9e9be8603d6be1fd7c1e8bbd6ec3add8a0f4c26f005910c3999`、
`sha256:e6fdaf2470fc3f151259aaab204c9a9862193b3ec4cbae3a0169a17a6bfc0478`、
`sha256:705f55b70bc61650196f437e4ae80935838677220b58a5de8baa7d6e9387c8d0`。
production-only audit 为 0；官方 nginx 1.29.8 `-t` 通过并保留 8 条既有 http2 兼容警告。

三端 standalone 归档 SHA-256 为
`12a4c7aca2a1cb4b94d58c828bb47f731a2454250e7769089b7a1dab454cc410`，下载前后一致。本地以
云端产物、隔离 PostgreSQL、MFA 默认关闭和全部外部写入禁用运行真实 Chromium 18/18：除三端
空浏览器登录、Host/Cookie audience、权限链接和五设备外，新增旅程实际创建并发布普通 Maintenance
角色，连续收到 201/200 且全程 dialog 数为 0。质量 schema
`quality_e2e_1787521174035_82127_261e8a2d` 已删除，runtime secrets 已移除，3740–3742 端口和
本机原 build cache 已恢复；云端临时镜像/目录已删除。两份用户本地修改哈希保持为
`103098cb5261603f7a43a262eedf34fe039daa8020fcbd35d0adf3e91c874c05` 与
`bfc34d26f32c8c446edfed842420b31abb74a66875715f5ed77c0091396c1b95`，未纳入提交。未启动远端
服务、未执行生产迁移、未接触生产数据库、未推送、未部署。

## 76. 2026-08-24 T4.2 旧 Client 元素退役与行情生产边界修正

已按确认需求完成任务看板 4.2。Client `/market` 不再展示或调用观察名单，对应
`/api/market/watchlist` 已从 Client 路由、生成 inventory 和 Client 最小数据库授权删除；历史
`market_watchlist` schema 与数据仍保留，未执行破坏性迁移。`/assistant` 没有分析标的选择和旧
8 卡片，仅保留 4 个快捷问题；`/studio` 的账户、合约、周期、方向是确定性研究输入，明确保留。

实现提交为 `a43c1d5`，浏览器覆盖提交为 `067318d`，19 项门禁计数提交为 `805cf55`。首次最新
产物浏览器运行暴露两项真实问题：新闻 eyebrow 在白底只有 2.71:1 对比度，遗留 Client 代码还会
尝试直连 `data-stream.binance.vision`，但生产 CSP `connect-src 'self'` 会阻断，而且现有规格明确
真实 WebSocket adapter 尚未完成。修复提交 `f012d78` 改用可读的 `--rv-brand-ink`，删除虚假的
浏览器外部 WebSocket，继续用同源 quote/candles/news API 和服务端时间派生 freshness；同时在
浏览器 fixture 结束时卸载 context route，避免轮询请求与 teardown 竞争。`3dd95c2` 将旧的
socket-onerror 测试更新为同源轮询、离线降级和禁止外部 stream 的当前合同。

最终本地 `npm test` 1412/1412、TypeScript、全仓 ESLint、8 条架构边界、repository secret scan
（3085 个候选文件）、production dependency audit 0 与差异检查全部通过。云端以运行时代码提交
`f012d7887afa253339e73dbf4d5a8c4d96dfc190`、tree
`5a4e8e685f6c2bd09c5a1b0a7b60b770f2ad2aa0` 的 3085 文件 Git 归档构建；本地与 `an-saas` 接收的
源码 SHA-256 均为 `6f379d1d2ede2b6d28bbe9ff2c6aec7a8d632fe2f9baeeb82daa795fc377c1a0`。
固定 Node 22.21.1 完成 Client 67、Operations 62、Maintenance 51 页 production build，
production-only audit 为 0，bundle budget 与三端 key-custody 通过；Client 路由清单中不存在
watchlist API。nginx 配置沿用本切片此前同文件的官方 `nginx:1.29.8-alpine` 语法通过证据，后续
提交未改动 `deploy/nginx`。

三端 standalone 归档 SHA-256 为
`2171ea6d090d448adcd52fdc0d0a7adff477b8817221af51c84a84c419175441`，下载前后一致。本地以该
云端产物、隔离 PostgreSQL、MFA 默认关闭和全部外部写入禁用运行真实 Chromium，最终 19/19：
覆盖三端空浏览器登录、Host/Cookie audience、权限链接注册、五设备、Client 行情搜索/品种索引、
四断点/axe、零观察名单请求、零外部 WebSocket/CSP 错误，以及 Maintenance 配置全程无确认弹窗。
质量 schema `quality_e2e_1787523092119_91458_3c7a564d` 已删除，runtime secrets 已移除，清理失败
为 0。本机 `3002` 被另一长期服务占用，因此使用项目自带且已有单测的
`QUALITY_E2E_PORT_OFFSET=10000` 在 13000–13002 完成同一标准门禁，未终止用户进程。

测试前本机三份 build cache 已恢复；两份用户本地修改哈希仍为
`103098cb5261603f7a43a262eedf34fe039daa8020fcbd35d0adf3e91c874c05` 与
`bfc34d26f32c8c446edfed842420b31abb74a66875715f5ed77c0091396c1b95`，未纳入任何提交。未启动
远端服务、未执行生产迁移、未接触生产数据库、未推送、未部署。真实 WebSocket/provider adapter
仍属于 M-02 后续任务，不能因本切片完成而标记为 CURRENT。

## 77. 2026-08-24 T4.3a AI 普通对话取消、重试与 Credits 单终态

已完成不依赖 P-08 具体数值的普通对话闭环。消息 SSE 在持久化用户问题后返回服务端拥有的
`inferenceRequestId`；Client 随即显示“取消生成”，单击直接中断浏览器 stream 并调用
`POST /api/ai/inferences/:id/cancel`，不增加确认弹窗。取消 API 需要当前 Client session、
`client.paper.view`、same-origin 与 Idempotency-Key，只按当前用户查找 inference；浏览器不能提交
user、reservation 或 Credits 数值。provider 外部 AbortSignal 与 45 秒超时组合，并传入首次回复及
DSL 修复调用。

Credits 终态在 inference/reservation 行锁下决定：取消未结算请求只写一次 release，完成先赢则保留
结果和 settle，已结算但结果未完整持久化进入 `AI_RECONCILIATION_REQUIRED`，迟到 provider 成功
不能重开 cancelled/failed 请求。网络结果不确定时 Client 的“重试原请求”继续复用同一
Idempotency-Key，只查询已存在结果。用户问题一经持久化即保留；取消不会删除历史消息或流水。

规格和实现提交为 `b8b1bda106e1ac72c6e0c39d73d6cc81717e863e`。首次云端产物 Chromium
运行在新增 AI 页面 axe 检查中发现 eyebrow 白底对比度仅 2.71:1；未降低门禁，提交
`2faf8d890624cee5ecb907cbfa9ee91e7a604630` 改用 `--rv-brand-ink` 后重建并复验。最终 tree 为
`4af0d8f8afb9fb63926aa02c89ebab1fd0d5370e`，Git 归档 3087 个文件；本地与 `an-saas` 接收的源码
SHA-256 均为 `1ef9bb0b540e9d9ed5550764ba4d90b5d2891a1f805770e555b4427c74acfee2`。

固定 Node 22.21.1 云端容器完成 Client 67、Operations 62、Maintenance 51 页 production build；
production-only audit 0，bundle budget 和三端 key-custody 通过。最终 standalone 归档 SHA-256 为
`4c63d72d962467aa682b8bfc73ac56db28883cca22e9a02d3e8e3ecd628a4973`，下载前后一致。
本地全量逻辑测试 1418/1418、TypeScript、全仓 ESLint、8 条架构边界、secret scan 和差异检查通过。

同一云端 production 产物在 MFA 默认关闭、全部外部写入禁用、隔离 PostgreSQL 与端口偏移 10000
下完成真实 Chromium 19/19：覆盖三端空浏览器登录、Host/Cookie audience、权限链接、五设备、
Client AI SSE 取消一次请求/保留问题/零 dialog/axe，以及 Maintenance 配置全程无确认弹窗。
质量 schema `quality_e2e_1787524814964_5996_1b49de94` 已删除，runtime secrets 已移除，清理失败为 0；
本机原三端 build cache 已恢复。

固定 Credits 每次对话数值及模型/功能分档仍由 P-08 阻断；当前 `token-cost-v1` 可信用量结算不能
冒充目标固定价格。两份用户本地修改哈希仍为
`103098cb5261603f7a43a262eedf34fe039daa8020fcbd35d0adf3e91c874c05` 与
`bfc34d26f32c8c446edfed842420b31abb74a66875715f5ed77c0091396c1b95`，未纳入提交。未启动远端服务、
未执行生产迁移、未接触生产数据库、未推送、未部署。

## 78. 2026-08-24 T3.9a Maintenance AI 用量安全聚合

T3.9a 已实现并通过完整 Gate。Maintenance 新增 `/ai-usage` 与
`GET /api/maintenance/ai-usage`，只读权限为 `maint.ai_usage.view`。查询以
`client_ai_inference_requests.created_at` 作为 UTC 请求创建 cohort，只统计已经完成 Credits 预留并
建立 inference 记录的总体；默认最近 30 个 UTC 自然日，最大 90 天，高基数组维度只返回请求量
Top 50。响应设置 `no-store`。

指标包括成功请求的可信输入/输出 Token、真实 settled Credits 和“已记录非取消失败率”。该失败率
只以非取消失败终态为分子，以成功加非取消失败为分母；preflight 拒绝、用户取消和处理中请求均不
进入口径，因此不能描述为系统失败率或 provider 可用率。组织使用请求级归属快照，并区分
`captured_at_request`、`legacy_current_backfill` 和 `legacy_unattributed` 证据质量；用户只返回稳定
伪名，模型固定到请求使用的 revision，另提供 Agent、功能和日期维度。API/UI 不返回原始用户 ID、
客户 PII、AI 内容、错误原文、provider request ID 或模型凭证。

Maintenance 页面内直接应用日期，不使用确认弹窗。当前 MFA 全局 Gate 默认关闭，不额外打断登录
或查看；正式生产重新开启后，敏感权限的 recent MFA 要求仍由服务端执行。P-08 的固定对话 Credits
数值和模型/功能价格分档仍未确认，当前可信用量及 settled Credits 不得冒充固定价格已完成。

查询服务把原先七次串行聚合收敛为一个带 `MATERIALIZED` 基础集的只读事务查询，并设置 5 秒语句
超时；PostgreSQL 迁移在任何 Maintenance audience 撤权墓碑存在时都不会把权限重新授予
`tech_staff`。无效共享 URL 仍按原始参数请求并显示 400，但只把合法 `YYYY-MM-DD` 写入原生日期
输入框，因此错误可恢复且不会产生浏览器格式告警。普通邀请链接重生成、组织关系/账号生命周期、
关系重邀和策略版本恢复也改为页面内影响说明、审计原因与单击执行；资金审批、权限撤销/双审、全局
熔断、恢复码和会话撤销等高风险动作继续保留确认或服务端 Gate。

最终本地 `npm test` 1430/1430、TypeScript、全仓 ESLint、8 条架构边界、repository secret scan
（3096 个候选文件）、production dependency audit 0 和差异检查全部通过。云端初始精确源码归档
本地/远端 SHA-256 均为
`663a0cbad291cf76b892e5285a07f46cb348349f599b19b9bab32bc10cf8dd47`；最终 Maintenance UI
文件以 SHA-256
`bfba6a4c8c14898bc4336b1b4f97f8f725d183571439a504cba15d177b612ed5` 同步到同一构建目录后单独
重建。`ssh an-saas` 固定 Node 22.21.1 完成 Client 67、Operations 62、Maintenance 52 页
production build，bundle budget 与三端 key-custody 通过；production-only audit 为 0。官方 Nginx
配置语法检查通过，仅保留 8 条既有 `listen ... http2` 弃用警告。

初始三端完整 Web 产物 SHA-256 为
`5787ff797515286f83fe36b6c223a5456af3e3450d58f6ea1bf62ef94f5d3363`；最终 Maintenance
standalone + static 归档 SHA-256 为
`4a5376e024d3146f59850aa2f254a45d05b6014d877f1ec7341925b63cb5a875`，下载前后一致。本地使用
未受影响的 Client/Operations 云端产物和最终 Maintenance 产物，在隔离 PostgreSQL、MFA 默认关闭、
全部外部写入禁用及端口偏移 10000 下完成真实 Chromium/axe 20/20。旅程覆盖三端空浏览器登录、
Host/Cookie audience、权限链接注册、五设备、客户/运营/维护工作区隔离、普通配置零冗余确认弹窗，
以及 AI 用量有权限访问、日期应用、非法共享 URL 错误恢复和零控制台告警。

质量 schema `quality_e2e_1787528629948_38829_4c22d548` 已删除，runtime secrets 已移除，清理失败
为 0，本机原三端 build cache 已恢复。两份用户本地修改哈希仍为
`103098cb5261603f7a43a262eedf34fe039daa8020fcbd35d0adf3e91c874c05` 与
`bfc34d26f32c8c446edfed842420b31abb74a66875715f5ed77c0091396c1b95`，不会纳入本轮提交。未执行
生产迁移、未接触生产数据库、未启动或切换远端服务、未推送、未部署。P-08 固定 Credits 数值与
模型/功能分档仍保持阻断。

## 79. 2026-08-24 T4.13a-BE Client 工作记录后端与保留基础

本轮完成工作记录的后端纵向基础，不包含 Client 页面或 Maintenance 导出。新增
`GET /api/work-records` 与 `GET /api/work-records/:id`，统一使用 `client.paper.view`、私有不缓存响应、
最多 50 条不透明游标和非法/未知/他人/订阅空档统一 404。详情只返回公共七阶段 allowlist 证据、行情
安全摘要，以及当前客户部署链下的组合准入、模拟意图和模拟成交；明确
`realOrderRoutingEnabled=false`，不调用 LLM、不触发订单或外部写入。

0075 迁移新增不可变 `strategy_subscription_periods`。共享轮必须同时匹配客户、部署 owner、策略卡、
品种、固定策略版本和订阅期间；启用、停止和模式切换使用同一用户 advisory lock 串行化，暂停不关闭
期间。数据库触发器证明客户/订阅/部署/版本/卡片/品种/模式属于同一事实，拒绝区间重叠和除首次关闭
之外的改写；旧部署缺 migration map 时失败关闭，不再用无目标 `ON CONFLICT DO NOTHING` 静默丢
历史。legacy text 时间由带订阅 ID 的安全解析函数校验。决策轮、事件、周期、行情快照、模拟意图和
期间在六个月内禁止删除，模拟成交继续沿用更强的永久追加式保护。

提交前多 Agent 只读安全审查发现并修正三项 P1：固定版本未参与共享轮 join、所有无 cycle 的轮都被
误报“无需准入”、列表缺少热路径索引和语句超时。现在只有纯 `hold` 且无 cycle 才标记
`not_required`，其他无 cycle 公共轮标记 `not_recorded`；列表与详情均使用 5 秒只读事务超时，并为
决策轮、准入周期和模拟意图增加索引。PostgreSQL 反例覆盖跨客户 IDOR、订阅空档、版本错配、纯
hold、非 hold 缺准入、连续分页、跨事实插入、区间重叠和六个月删除保护。

本地最终 `npm test` 1436/1436、TypeScript、全仓 ESLint、8 条架构边界、API inventory、Nginx
allowlist 和差异检查全部通过。云端以证据回填前的最终运行时暂存树
`5fb966a713ebd111549b554b491a9e27b43b43b8` 的 3104 文件归档构建，本地/`an-saas` 源码 SHA-256
均为 `c5af4fbeb5408c5746ed7cfd5956180da02c867bdf2d8a8a55a78348cbdd2f32`。固定 Node 22.21.1
production build 完成 Client 68、Operations 62、Maintenance 52 页；三端构建镜像摘要依次为
`sha256:3f95947275c19e2c1c81aaf7c49c6abe3bf807825c39ef764bbbcaa5add786ff`、
`sha256:f5c74448b4382dc1c0fef3bb0c955b3f24d110c8cd0a25de583b7cecba72cb56`、
`sha256:bc5a0f86bfb4a1928b6ef6d3343b9815dc34d04d36d2765d2e0067903cadef95`。production-only audit
为 0，三端 server JavaScript 不含交易所凭证加解密能力；临时源码和镜像已删除。

两份用户自有修改哈希保持为
`103098cb5261603f7a43a262eedf34fe039daa8020fcbd35d0adf3e91c874c05` 与
`bfc34d26f32c8c446edfed842420b31abb74a66875715f5ed77c0091396c1b95`，未纳入本轮提交。未执行生产
迁移、未接触生产数据库、未启动或切换远端服务、未推送、未部署。下一切片是 4.13a-UI；之后才是
4.13b Maintenance security-barrier 脱敏导出与最终浏览器 Gate。

## 80. 2026-08-24 文档与现状对齐（接管切片）

从 `7c047b6` 接管后先做纯文档同步，不改任何运行时代码。本轮只修正文档与代码事实不符之处，
不改变任何产品决策、安全边界或 Gate 结论；六处修正均以仓库实际代码/迁移/测试输出为依据。

`docs/product/FUNCTIONAL_DESCRIPTION.md` 有三处内部矛盾：§3.1 已写「MFA 当前不强制」，
§5.2 却仍写「首次登录必须完成 TOTP」，§18 三条旅程也以 MFA 开启为前提。现按 ADR-0023 统一为
「由 `MFA_ENFORCEMENT_ENABLED` 控制，当前默认关闭、能力与数据完整保留」，并在 §18 开头一次性
说明关闭态语义，不逐条改写旅程。§10.1 路由表的 `/organization` 组织架构行与 T1.1 的退休结论冲突，
改为 `/accounts` 平面账号目录并补 `/invitations`、`/kill-switches`、`/live-routing`；§10.3 标题与正文
同步改为「运营账号和邀请」，明确后端 organization/归属事实仍供 scope resolver 使用，逐人创建成员
写接口已 `410 Retired`。§11.6 Worker 清单补 Configuration Activation Worker，并单列 Execution Service
为独立进程（不接受公网入站、唯一持有凭证解密能力、实盘仍由命名闸门关闭）。

`docs/specs/SYSTEM_SPEC.md` 的拓扑图缺 Configuration Activation Worker 与 Execution Service，已补。
§2 三份稳定路由清单全部过期，按 `app/riverton-route-contract.ts` 实况更新：Client 补 `/dashboard`、
`/work-records[/id]`、`/market`、`/assistant`、`/studio`、`/backtests`；Operations 去 `/organization`、
补 `/accounts`/`/invitations`/`/kill-switches`/`/live-routing`；Maintenance 补 `/ai-usage`、`/readiness`、
`/configurations`、`/releases`。§6 原写「恢复证据只覆盖至 `0042` 的 43 个迁移」，与
`QUALITY_RELEASE_EVIDENCE.md` 记录的 2026-08-23 演练（至 `0062`、63 个迁移、146 张表）互相矛盾，
而当前目录已有 76 个迁移文件（至 `0075`）——两个数字都不是现状。现改为明确声明**恢复 Gate 处于
失效状态**：引用真实演练范围，指出此后新增 `0063`–`0075` 共 13 个迁移使其不再覆盖完整集合，
必须重跑 fresh/N-1/rerun/concurrent 与隔离 backup/restore 才能恢复 Gate。固定迁移清单不再复制
全部 76 条，保留 Beta 基线 `0021`–`0043` 并按能力分组概述 `0044`–`0075`，声明目录本身是真源。

`tasks/plan.md` 的 Phase 4 与 `tasks/todo.md` 看板是两套编号：计划 T4.2/T4.3/T4.4 是准入状态机/
策略广场/跟单闭环，看板 4.2/4.3/4.4 是移除观察名单/AI 取消/候选编辑，此前只能靠
「T4.1b（对应任务看板 T4.2）」这类行内注释自救，容易照数字做错任务。现在 Phase 4 开头给出完整
映射表，并要求新增条目同时登记两侧编号。

`CLAUDE.md` 是每次会话都加载的文件，两个数字已明显过期：`npm test` 写 776 项（本轮在 `7c047b6`
实测 1435/1435），三端路由条数写 87/75/56（现为 206 个路由文件，进 client 93、operations 84、
maintenance 66）。已更新并注明这些数字随切片增长、以命令输出为准不要手工递增。`AGENTS.md` 的
「Continue feature work on `codex/three-app-riverton-split`」已失效，改为以 `tasks/plan.md` 顶部
分支为准，并说明该分支只是最后一个推送到 origin 的分支。

本文 §1 接管入口清单仍指向 ADR-0003/0004 与旧分支，与顶部 V3 更正注冲突。已改为
AGENTS/CLAUDE → docs/README → 文档状态矩阵 → PRD/SYSTEM_SPEC → tasks → 本文最新条目 → 相关
ADR/spec → git 状态，并显式标注 §3–§9 描述的是已被 P4 删除的历史代码结构，保留为历史记录而非
现状说明。

验证：`npm test` 1435/1435、`npx tsc --noEmit`、`npm run lint`、`git diff --check` 通过。纯文档提交
不触发构建产物、bundle 预算或浏览器 Gate 变化，也未执行迁移、未接触数据库、未推送、未部署。

## 81. 2026-08-24 T4.13a-UI Client 工作记录页面

看板 4.13a-UI 已完成，4.13a 整体收口。新增 `/work-records` 列表与 `/work-records/:id` 详情，
消费 `7c047b6` 落地的两个 Client API，不新增 route、迁移或权限，也不触发任何外部写入。

**先说这个切片最容易静默出错的地方。** 路由白名单（`app/riverton-route-contract.ts`）与
`client-portal.tsx` 的 if/else 分发是两份真源，而分发的兜底分支是 `<WalletWorkspace />`。
`work-records` 在 4.13a-BE 时就已经进了白名单但没有分支——只加白名单不会报错，用户点导航
会看到「资产与账本」而不是 404，在浏览器里几乎认不出来。因此本轮除了补分支，还加了一条
通用守卫测试：从合同里解析 `CLIENT_ROUTES`，逐条断言分发里存在对应 `route === "..."`，
只放行两个有据可查的例外（`login` 由 `client-portal-root.tsx` 在进入 portal 前分流、
`wallet` 是刻意兜底）。该测试先以 RED 验证过——删掉分支后它准确报出「会静默落到兜底的钱包页」。

详情按规格 §7 排序为公共决策 → 行情摘要 → 七阶段 → 你的组合准入 → 模拟意图/成交 → 审计边界。
准入五种状态逐一给文案，**刻意不合并 `not_required` 与 `not_recorded`**：前者是「纯 hold 且无
客户周期，本轮不需要准入」的产品规则，后者是「没查到你的准入记录」的证据缺失，合并会让缺证据
看起来像规则如此（INV-6）。页面同时说明公共七阶段由订阅同一张卡的所有客户共享、准入与模拟成交
按本人组合单独计算，并明示 `realOrderRoutingEnabled=false`、Paper 盈亏不可提取。

分页用「加载更多」而不是页码——游标是服务端编码的不透明位置，跳页无意义。这里没有复用
`useApiData`：它每次取数替换整个结果，而追加分页需要累积，把累积放进 effect 会变成
「effect 内同步 setState」（ESLint 实际报了这条）。改为局部 `useWorkRecordFeed`，取消、
序号防陈旧和 401 跳转与 `useApiData` 保持一致，并按 `recordId` 去重，让「不重复不跳项」
不依赖服务端游标在边界上的行为。

包体是这个切片的硬约束。工作区经 `next/dynamic` 懒加载，实测 Client 初始 JS 从基线
204,048 增加到 204,127 字节（预算 204,800，余量 673），**净增 79 字节**——只有导航项和分发
分支的体积，工作区本体没有进初始包。基线值是本轮实测的：`CLAUDE.md` 原写「余量约 160 字节
（204,636）」已过期，已按实测更新。

两处让步都记录原因：可滚动表格容器带 `tabIndex={0}` 与 `jsx-a11y/no-noninteractive-tabindex`
冲突，但 axe 的 `scrollable-region-focusable` 要求可滚动区必须能被键盘聚焦——窄屏下这张表要
横向滚动，没有 tabIndex 用键盘就读不到右侧的列。沿用 `decision-hall.tsx` 已有的处理：
`role="region"` 加逐行说明的 eslint-disable，不放宽规则本身。

验证：`npm test` 1440/1440、TypeScript、全仓 ESLint 0、8 条架构边界、三端 key-custody、
repository secret scan（3106 个候选文件）、API inventory 269 条与 Nginx 白名单同步、
production dependency audit 0、`git diff --check` 通过。三端 production build 成功，
bundle budget 通过。本地隔离 PostgreSQL、MFA 默认关闭、外部写入全禁用、端口偏移 10000 下
真实 Chromium **20/20**：`/work-records` 已并入 Client 稳定页巡检，在 320/768/1024/1440
四档断言「工作记录」标题可见（分发若漏配会落到钱包页、标题不匹配即失败），并覆盖键盘可达、
axe critical/serious、资源预算与 console/network 零错误；三端空浏览器登录、Host/Cookie
audience 隔离和 Maintenance 无确认弹窗一并回归。质量 schema
`quality_e2e_1787534226442_27288_7b6a4ae0` 已删除，运行时秘密已移除，清理失败为 0，
一次性测试库已 drop。

全量测试期间出现过 `tests/configuration-activation-worker-postgres.test.mjs` 的 2 项失败，
错误是 `role "maintenance_ai_usage_reader_*" does not exist`。该角色由
`tests/maintenance-ai-usage-postgres.test.mjs` 创建，而 PostgreSQL 角色是集群级的，两个测试
文件共用同一个集群时存在 teardown 竞争。已确认这是既有夹具问题而非本轮引入：在**移除本轮
全部改动**的基线上连跑三次，第一次同样复现。没有改业务代码或测试断言去掩盖它；这属于
§73 记录过的同一类跨文件临时角色竞争，值得单独做一次夹具隔离。

未做：4.13b Maintenance security-barrier 脱敏导出，以及 4.13c-E2E 里属于导出旅程的部分。
本轮没有云端三端构建（本地 production build 已通过，最终收口仍应在云端精确提交快照重跑）。
未执行生产迁移、未接触生产数据库、未启动或切换远端服务、未推送、未部署。

## 82. 2026-08-24 T4.13b Maintenance 工作记录脱敏导出

看板 4.13b 已完成（WR4 安全投影 + WR5 受控导出）。Maintenance 新增 `/work-records` 导出页与
`POST /api/maintenance/work-records/export`；真实订单路由不变，导出不触发任何外部写入。

**这个切片的核心不是导出接口，是运维端的读权限边界。** Maintenance 的产品边界是「不展示客户
业务信息」，导出工作记录是这条边界上的一个例外。如果直接让运维端读 `strategy_decision_rounds`
等业务原表，就等于为了一个导出把整条客户决策链对运维端敞开。迁移 `0076` 因此建
`maintenance_strategy_work_records_safe` security-barrier 视图作为唯一入口，只投影 21 个
allowlist 字段，客户仅以 `md5(owner_user_id)` 单向伪名出现；同一迁移把
`strategy_decision_rounds`、`strategy_runtime_cycles`、`strategy_runtime_events`、
`strategy_subscription_periods`、`official_paper_order_intents`、`official_paper_fill_receipts`
从 `agentnovas_maint_web` 撤权。实际 PostgreSQL 测试用一个只被授予视图 SELECT 的临时角色，
逐张断言这些原表返回 42501——**视图存在不等于原表已经关上**，这条断言才是边界的实际证明。
`security_barrier=true` 也单独断言：没有它，调用方传入的函数可能先于安全条件求值。

视图字段用 `assert.deepEqual` 逐个列出而不是「不含某某」。后者只能挡住已经想到的泄露，前者
要求以后每加一个字段都被显式复核一次。

导出的准入口径与 Client 侧共用同一套 CASE：只有纯 `hold` 且无客户周期才是 `not_required`，
其余缺周期一律 `not_recorded`。两边分别实现会让同一轮在客户页和导出里有两种解释。

API 侧：独立敏感权限 `maint.work_records.export`（不搭在 `maint.ai_usage.view` 或
`maint.audit.view` 上——能看聚合用量不等于能导出逐条客户决策记录），same-origin、
`Idempotency-Key`、8 KiB 严格 body（多余字段一律 422，避免以后靠隐藏参数扩大导出范围）。
日期两端包含、最多 31 天：`2026-02-30` 这类会被 `Date.parse` 静默归一到 3 月的输入被显式拒绝，
否则导出范围会悄悄改变。命中 1,000 条上限时返回 `truncated=true` 并在页面上以 `role="alert"`
说明「不是该区间的完整记录」（INV-6）。响应带 `content-disposition: attachment`、`no-store`、
`x-export-retention: none`，服务端不落导出文件；审计只写日期、条数、截断状态、查询摘要和原因，
不写导出正文。`reason` 进入幂等 payload——换一个原因就是另一次导出，必须重新留审计。

Maintenance `/work-records` 是**导出页而不是逐条详情页**。路由合同按 audience 分块，
maintenance 落在 `segments.length === 1`，`/work-records/:id` 返回 404；让运维端能打开详情页
就等于给了它逐条查看客户决策的入口。

三处实现过程中真实暴露的问题，都不是靠改断言绕过的：

1. 新权限键必须先进 `permission_definitions`，否则 `role_permissions` 外键直接 23503。
   `internal-member-provisioning` 测试因此变红——它手工列权限而不是走迁移链，已补齐。
2. 导出测试第一版把全部迁移一次跑完再插夹具，结果 `0075` 的订阅期间回填看不到这些部署，
   视图零行——测试会「通过」在空数据集上，什么都不证明。改为与既有工作记录测试同样的两阶段：
   先跑到 `0074`，插夹具，再应用 `0075`/`0076` 并断言恰好这两个被应用。
3. 首次浏览器 Gate 19/20：质量夹具的 maintenanceAdmin 身份没有新权限，页面渲染成无权访问，
   标题断言失败。这正是这条巡检该抓的东西——补权限后 20/20。

验证：`npm test` 1454/1454、TypeScript、全仓 ESLint 0、8 条架构边界、三端 key-custody、
repository secret scan（3112 个候选文件）、API inventory 270 条与 Nginx 白名单同步、
production dependency audit 0、`git diff --check` 通过。完整 77 个迁移在一次性库上 fresh 应用
成功并可重放（第二次 0 applied / 77 skipped）。三端 production build 成功，bundle budget 通过
（Client 204,171、Operations 192,720、Maintenance 192,915，均在 204,800 预算内；Maintenance
本切片 +126 字节，导出工作区经 `next/dynamic` 懒加载）。本地隔离 PostgreSQL、MFA 默认关闭、
外部写入全禁用、端口偏移 10000 下真实 Chromium **20/20**，`/work-records` 导出页已并入
Maintenance 稳定页巡检，覆盖四断点、键盘、axe 与 console/network 零错误。质量 schema
`quality_e2e_1787540902743_78967_98a92ed0` 已删除，运行时秘密已移除，清理失败为 0，
两个一次性测试库已 drop。

未做：4.13c-E2E 中「导出主旅程」的交互级用例（当前只覆盖页面巡检，未实际提交一次导出并断言
审计与幂等重放），以及云端 `ssh an-saas` 精确提交快照的三端构建收口。未执行生产迁移、
未接触生产数据库、未启动或切换远端服务、未推送、未部署。

## 83. 2026-08-24 T4.13c-E2E 导出主旅程与工作记录夹具

4.13c-E2E 已完成，4.13 整体收口。新增 Maintenance 导出的交互级浏览器用例，并让质量夹具第一次
带上真实工作记录数据——在此之前 Client `/work-records` 与导出页在浏览器里都只渲染空态，
表格标记、伪名、准入文案和可滚动区的 axe 从未被真正跑到。

导出用例不只是打开页面看标题：它先验证按钮在原因未填、区间超过 31 天时保持禁用并说明原因，
再实际提交一次导出，断言请求体**恰好**是 `{from,to,reason}`（浏览器不能夹带 limit、customerId
之类扩大范围的参数）、带 `Idempotency-Key`、响应头有 `attachment`/`no-store`/
`x-export-retention: none`，正文里每行都是 32 位十六进制伪名且不含 `@`、不含 `ownerUserId`
或 `customerId`，`recorded` 与 `not_required` 两种准入状态同时出现（「无需准入 ≠ 未记录」
这条边界要在浏览器里被看到），全程零确认弹窗，最后跑四断点与 axe。

**夹具怎么挂是这轮真正花时间的地方，三次都被产品不变量挡回来。** 第一版把工作记录链挂在主
客户身上并新建一份 active 会员，商业闭环用例立刻红：会员激活会拒绝「客户存在多个当前会员
权益」。改成 `expired` 会员后又红在另一处——`expect(portfolios.data).toHaveLength(3)`，
「每位会员恰好三张 10,000 USDT 组合」是产品不变量，夹具再造一张就把它测成了 4 张。第三次
索性不建组合，数据库直接拒绝：0024 的 `strategy_deployments_official_binding_check` 要求官方
spot 部署必须绑定组合与会员。最终把整条链换到 `clientSecurity`——一个只用于登录和设备用例、
没有组合断言的客户身份。**三次失败都是既有断言在正确工作，没有一次是靠放宽断言解决的。**

导出接口在浏览器里 500，根因是我只在 TypeScript 侧加了幂等操作枚举，忘了同步 0039 建的数据库
CHECK allowlist：应用层认为合法，数据库 23514 拒绝，而错误被安全信封折叠成 `INTERNAL_ERROR`
看不出真因。迁移 0076 补上约束，并新增一条守卫测试——从 `lib/maintenance-idempotency.ts` 读出
应用层枚举，逐个断言数据库 CHECK 接受它，避免下一个人再踩。该测试先以 RED 复现过这个缺口。

还有两处小修：`getByLabel(/审计原因/)` 的正则同时命中两个元素（strict mode violation），改用
精确标签；导出结果面板与内部滚动区共用同一个 `aria-labelledby`，`getByRole("region")` 因此
解析出两个元素——两者语义本就不同，滚动区改用自己的 `aria-label="导出记录表格"`。中途还遇到
一次「改了源码但浏览器跑的是 standalone 产物」，重建 Maintenance 后才生效。

验证：`npm test` 1455/1455、TypeScript、全仓 ESLint 0、8 条架构边界、repository secret scan
（3112 个候选文件）、API inventory 270 条与 Nginx 白名单同步、`git diff --check` 通过；
三端 production build 成功、bundle budget 通过。本地隔离 PostgreSQL、MFA 默认关闭、外部写入
全禁用、端口偏移 10000 下真实 Chromium **21/21**。质量 schema
`quality_e2e_1787545987383_7430_41eebe0c` 已删除，运行时秘密已移除，清理失败为 0，
一次性测试库已全部 drop。

未做：云端 `ssh an-saas` 精确提交快照的三端构建收口（本地 production build 已通过）。
未执行生产迁移、未接触生产数据库、未启动或切换远端服务、未推送、未部署。

## 84. 2026-08-24 T4.13 云端构建收口、提交署名与协作规则纠正

4.13 的云端 production build 收口已完成。需求方明确授权可以操作云端主机（该环境尚未按其
要求进入生产），并要求提交不带个人信息、可走 git bundle 交接，同时指出 `AGENTS.md` 的部分
规则不合理、可以纠正。

**云端构建证据。** `ssh an-saas` 为 root@198.44.36.154，Docker 29.7.1，宿主本身没有 node。
以提交 `3a79b3f3eeb25939db99d5a73b56e17d0cafa28a`、tree
`92a289538c4af4927a7fb0276836ba0d037ec3fd` 的 3,112 文件精确 Git 归档构建；本地与 `an-saas`
接收的源码 archive SHA-256 均为
`ee3b3ffeb63ac8d9039eee3ea4a9fd20041e4925fa898cba6c3db58c285ae767`。容器为 `node:22.21.1`，
镜像摘要 `sha256:b84d52cd45bfe261096ccbf886955d431b8b9ed01b72eaef588e8886bda09e78`，容器内
`node --version` 实测 v22.21.1。`npm ci` 后三端 production build 全部成功；构建产物
`app-path-routes-manifest.json` 记录 Client 100、Operations 91、Maintenance 74 条路由；
云端 production-only audit 为 0 vulnerability。

**页数口径提醒。** 历史条目里的「Client 68 页」等数字来自 Next 构建输出的路由表，本轮改用
构建产物 manifest 的条目数，两者口径不同、不可直接比较。后续要么统一改读 manifest，要么
明确标注口径，不要把两种口径的数字并排对比。

一次性远端目录 `/tmp/agentnovas-wr-build-ricGNW` 已删除并验证不存在，本地归档也已删除。
未启动远端服务、未执行生产迁移、未接触生产数据库、未切流、未部署。宿主 `/tmp` 下另有三个
历史部署遗留文件（`agentnovas-backend-postdeploy.log`、`agentnovas-backend-v5.1.0.env`、
`agentnovas-backup-sha.out`），不属于本轮产物，未动。

**提交署名。** 接管的前五个提交原本由本机默认身份 `Kevin <kevin@KevindeMac-mini.local>`
署名。按需求方要求已 filter-branch 改写为 `Claude <noreply@anthropic.com>`，新 SHA 依次为
`6ca3a0c`、`d449b24`、`87256c2`、`1663357`、`4a69e52`；worktree 的 `user.name`/`user.email`
也已设为同一身份。改写前确认过这五个 SHA 没有被任何文档引用（条目 80–83 只引用起点
`7c047b6`），因此证据链没有断。

**继承的 169 个 Codex 提交刻意不改写。** 它们的 SHA 被 handoff 与 spec 当作实施证据引用了
26 处，改写会让这些引用全部悬空。对一个以「证据可复核」为纪律的项目，这个代价大于把
hostname 从历史里抹掉的收益。它们仍署名 `Kevin <kevin@KevindeMac-mini.local>`——是本机
hostname，不含真实邮箱。

**交接方式：git bundle，不推送。** 远端 `js2728520-collab/agentnovas-platform` 是**公开
仓库**，推送会把作者身份与全部文档永久公开。需求方因此选择 bundle：零公开风险，且所有 SHA
原样保留，上述 26 处证据引用继续可复核。生成方式与校验：

```bash
git bundle create <目标>.bundle claude/platform-v3-doc-sync
git bundle verify <目标>.bundle
```

首个交接件为 `agentnovas-platform3/agentnovas-4.13.bundle`，12.87 MiB、8,849 个对象，
`git bundle verify` 报告 "records a complete history … is okay"，可直接
`git clone -b claude/platform-v3-doc-sync <bundle> <目录>` 还原。**注意该 bundle 生成于提交
`9522e0d`，不含本条目；追加本条目后需要重新生成才能把这份证据带进交接件。**

**规则纠正。** `AGENTS.md` 原有两条与实际脱节。一条要求「未经许可不得推送」，但没有说明这个
远端是公开仓库——真正需要提醒的是推送会把作者身份和全部文档永久公开且无法撤回，而不是笼统
禁止；另一条把「本地提交」写成需逐次请求，与按切片提交并留证据的实际工作方式相反。现改为：
本地提交是常态；首次推送某分支前与需求方确认范围，之后按约定继续；提交一律使用
`Claude <noreply@anthropic.com>`，并说明身份必须在首次提交前就设好（事后改写会改变所有 SHA
并破坏 handoff 的证据引用）；同时把「在远端一次性目录里构建」与「部署」明确区分开——前者
不是部署，后者仍需针对具体动作的批准。

**一处需要记下的过程事实。** 本条目原本写在一个被权限分类器拦下的 Bash 调用里，那次调用整体
没有执行，因此追加从未发生；`AGENTS.md` 的修改走的是 Edit 工具，不受影响，于是提交 `9522e0d`
只含规则纠正而不含云端证据。教训是：把「写文件」和「提交」放进同一条 shell 调用，调用被拦时
两者一起丢，而中途的口头结论会与磁盘实际状态不一致。分开执行并逐项复核落盘结果。

## 85. 2026-08-24 T2.4b-2 行情源选择的作用范围与 Client 接线

提交：`8a5a607`（合同/迁移/解析/API）、`6f8e4b7`（Client 面板）。ADR：`docs/adr/0025-market-source-scope-and-official-card-rounds.md`。

**先解决的是一个设计问题，不是功能。** T2.4b-1 把解析结果不可变地固定到部署上之后，
ADR-0018 的一个潜在缺陷变得必须回答：决策轮身份是
`(strategy_code, symbol, timeframe, candle_close_time)`，**不含数据源**。两位订阅同一张
官方卡的客户若选了不同的源，那一轮就会拿 A 源的判断去解释 B 源的行情，而且是静默的。

数据模型先回答了一半：`strategy_decision_rounds.strategy_code` 有
`CHECK IN ('ai_conservative','ai_balanced','ai_aggressive')`——**共享轮只可能属于官方卡**，
自定义策略各自独立成轮。剩下的是产品问题：客户能不能给官方卡换源。需求方确认**不能**。

因此 **ADR-0018 的决策轮身份不需要修改**。T2.4b-1 里那条「等模型改之前的临时防线」
`assertRoundBindingConsistency` 含义随之改变：同一张官方卡上出现两个不同的 source policy
fingerprint，现在意味着有代码或数据违反了 ADR-0025，Runtime 必须失败关闭。它是常驻不变量
检查，不是待办事项。

**新增的偏好表与 0078 的绑定表是两件事。** 混淆它们会直接毁掉 0078 存在的理由：

| | 可变性 | 含义 |
| --- | --- | --- |
| `customer_market_source_preferences`（0079） | 可变 | 客户当前想用哪个源 |
| `strategy_market_source_bindings`（0078） | 不可变 | 某个部署当初实际解析到了哪个源 |

改偏好不动既有绑定——这正是「同一段历史决策不会在事后被换个数据源解释」的来源，
由 `tests/market-source-preference-postgres.test.mjs` 的跨表用例守住。

偏好按 **市场** 存而不按策略存，因此这张表在结构上就无法表达「给某张官方卡换源」——
没有 `strategy_code` 列可写。模式与标识由 CHECK 强制配对（`account_aligned` 恰好带
`account_id`，`independent` 恰好带 `provider_id`）：两个都填会让「客户选的到底是哪个」
出现两个答案，而解析只读其中一个，另一个成为看不见的错误配置。

**当前偏好实际只作用于展示与研发。** 0053 的 `strategy_deployments_official_binding_check`
要求 `execution_product = 'spot_usdt'` 的部署必须有 `platform_strategy_code`——库层就决定了
今天所有现货部署都是官方卡，客户自定义策略走永续而永续路由关闭。ADR-0025 第 2 条里的
「客户自己投稿的策略部署」是为将来准备的路径，不是现在跑着的路径。这一点写进了 ADR，
避免以后有人按文字以为它已经在跑。

**能力快照如实报告未配置。** `capabilitySnapshotFromRegistry` 直接取注册表的
`configured`，当前全部为 `false`——没有任何 provider 被真正接通过，解析一律返回
`source_not_configured`。测试里有一条 `providers.filter(p => p.configured)` 为空的断言，
第一个源真正接通时它会提醒更新（INV-6）。

**界面上三处刻意的区分。** 「已选择」与「平台默认」不合并显示（把默认值显示成当前选择，
客户无从知道自己选没选过）；「官方卡不跟随此设置」是常驻说明而非保存后的提示；保存失败
时不改本地选择（显示一个没有落库的选择比报错更糟）。官方卡代码由服务端响应携带，界面
不硬编码，测试断言面板源码里不出现这三个代码。

**RED 验证。** 删掉 `selectionForDeployment` 里的官方卡分支后，
「官方卡忽略客户偏好」用例转红，其余四条仍绿——确认这条断言测的是规则本身而不是恒真式。
夹具里客户偏好特意选 `exchange-okx`，与平台源 `exchange-binance` 不同，并有一条断言守住
这个前提。

门禁：`npm test` 1517/1517（新增 17 项）、`tsc`、ESLint 0、8 条架构边界、三端构建、
包体预算。Client JS 204,171/204,800，余量 752 → 629 字节（面板 123 字节，因为
`live-market` 本就走 `next/dynamic`，只有共享块的增量落到公开落地页）。

**未做，留给后续：** Runtime Worker 尚未在开仓前调用 `assertRoundBindingConsistency`，
守卫目前只有直接测试覆盖，没有接进决策周期；`app/api/market/*` 的报价与 K 线仍走既有
公共源，没有按偏好取数——那要等真实 provider 接入（T2.2b/T2.5），现在接会变成伪装就绪。
