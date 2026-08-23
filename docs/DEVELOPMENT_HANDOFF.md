# AgentNovas 开发环境交接说明

> 2026-08-23 V3 文档同步：当前目标文档分支为 `codex/platform-v3-doc-sync`。需求方已确认完整三端平台 PRD V3.0；先阅读 `docs/DOCUMENT_STATUS_MATRIX.md`、`docs/product/PRD.md`、`docs/roadmap/FULL_PLATFORM_V3_ROADMAP.md` 和 `tasks/todo.md`。当前生产仍是 Beta/Paper 基线，真实交易、永续、提现/划转和 Maintenance 自动部署不得因目标文档存在而开启。

> 最新文档入口为 `docs/README.md`。本文第 13 节对前文“全部完成”的表述进行了状态校正；接管者应以最新 PRD、Spec、系统评估和任务清单为准。

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
| `live-market.module.css` | 行情终端（K 线、成交量、十字光标、关注列表、资讯） |
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
