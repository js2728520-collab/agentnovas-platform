# AgentNovas 开发环境交接说明

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
